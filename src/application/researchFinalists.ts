import { join } from 'node:path';
import process from 'node:process';
import { RunStore } from '../db/store.js';
import { CLUSTERING_ALGORITHM_VERSION } from '../enrichment/clustering.js';
import { assertRepresentativeSourceFreshness } from '../enrichment/representativeSourceFreshness.js';
import type { CancellationSignal } from '../enrichment/types.js';
import { CLUSTER_URL_IDENTITY_VERSION } from '../enrichment/urlIdentity.js';
import {
  resolveEnrichmentLocation,
  resolveOutputRoot,
  resolveRunLocation,
} from '../outputs/researchLayout.js';
import { buildExistingResearchPlan } from '../operatorConfig/planner.js';
import { readOperatorConfigProvenance } from '../operatorConfig/provenance.js';
import { buildResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';
import { resolveOperatorContinuationInput } from './operatorInputs.js';
import { executeExistingResearch, type ResearchControlOptions } from './researchControl.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  type ResearchRunDeps,
  type ResearchRunExecution,
} from './researchWorkflow.js';

export type ResearchFinalistClusterV1 = {
  clusterId: string;
  canonicalKeyword: string;
  memberCount: number;
  medianVolume: number | null;
  averageVolume: number | null;
  representativeDomains: string[];
  cohesion: {
    urlJaccardMedian: number | null;
    domainJaccardMedian: number | null;
  } | null;
  members: Array<{
    keyword: string;
    normalizedKeyword: string;
    volume: number | null;
    serpSize: number;
  }>;
};

export type ResearchFinalistScopeGateV1 = {
  version: 1;
  researchId: string;
  discoveryRunId: string;
  enrichmentId: string;
  clusterCount: number;
  clusters: ResearchFinalistClusterV1[];
};

export type ResearchFinalistScopeSelectionV1 =
  | { version: 1; enrichmentId: string; mode: 'selected'; clusterIds: string[] }
  | { version: 1; enrichmentId: string; mode: 'all' };

export type ResearchFinalistScopeServiceDeps = {
  buildStatus: typeof buildResearchStatusWithHistoricalPresence;
  loadProvenance: typeof readOperatorConfigProvenance;
  buildPlan: typeof buildExistingResearchPlan;
  loadClusters: typeof loadFinalistScopeClusters;
  resolveContinuation: typeof resolveOperatorContinuationInput;
  executeExistingResearch: typeof executeExistingResearch;
};

export const DEFAULT_RESEARCH_FINALIST_SCOPE_DEPS: ResearchFinalistScopeServiceDeps = {
  buildStatus: buildResearchStatusWithHistoricalPresence,
  loadProvenance: readOperatorConfigProvenance,
  buildPlan: buildExistingResearchPlan,
  loadClusters: loadFinalistScopeClusters,
  resolveContinuation: resolveOperatorContinuationInput,
  executeExistingResearch,
};

export type ResearchFinalistScopeOptions = {
  outputRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  signal?: CancellationSignal;
  serviceDeps?: ResearchFinalistScopeServiceDeps;
  workflowDeps?: ResearchRunDeps;
  runtime?: ResearchControlOptions['runtime'];
};

export async function inspectResearchFinalistScope(
  researchIdValue: string,
  options: Pick<ResearchFinalistScopeOptions, 'outputRoot' | 'env' | 'serviceDeps'> = {},
): Promise<ResearchFinalistScopeGateV1> {
  const researchId = requiredTrimmedString(researchIdValue, 'researchId');
  const env = options.env ?? process.env;
  const outputRoot = resolveOutputRoot(options.outputRoot ?? null, env);
  const deps = options.serviceDeps ?? DEFAULT_RESEARCH_FINALIST_SCOPE_DEPS;
  const status = await deps.buildStatus({ outputRoot, targetRunId: researchId });

  if (status.legacy) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'Finalist scope selection requires a managed research with persisted OperatorConfig provenance.',
    );
  }
  const provenance = await deps.loadProvenance(status.researchDirectory);
  if (provenance === null) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${status.researchId} has no persisted OperatorConfig provenance; finalist scope continuation is unavailable.`,
    );
  }
  const plan = deps.buildPlan(status, null, provenance);
  if (!plan.unresolvedHumanRequirements.includes('finalist_scope')) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${status.researchId} is not currently awaiting an explicit finalist scope.`,
    );
  }
  if (status.currentEnrichmentId === null) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Research ${status.researchId} is awaiting finalist scope without a current enrichment id.`,
    );
  }

  const clusters = await deps.loadClusters(outputRoot, status.currentEnrichmentId);
  return {
    version: 1,
    researchId: status.researchId,
    discoveryRunId: status.discovery.runId,
    enrichmentId: status.currentEnrichmentId,
    clusterCount: clusters.length,
    clusters,
  };
}

export async function executeResearchFinalistScopeSelection(
  researchIdValue: string,
  selectionValue: unknown,
  options: ResearchFinalistScopeOptions = {},
): Promise<ResearchRunExecution> {
  const selection = validateResearchFinalistScopeSelection(selectionValue);
  const deps = options.serviceDeps ?? DEFAULT_RESEARCH_FINALIST_SCOPE_DEPS;
  const gate = await inspectResearchFinalistScope(researchIdValue, {
    ...(options.outputRoot !== undefined ? { outputRoot: options.outputRoot } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    serviceDeps: deps,
  });

  if (selection.enrichmentId !== gate.enrichmentId) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Finalist scope targets enrichment ${selection.enrichmentId}, but current enrichment is ${gate.enrichmentId}. Reload current clusters.`,
    );
  }

  if (selection.mode === 'selected') {
    const available = new Set(gate.clusters.map((cluster) => cluster.clusterId));
    const unknown = selection.clusterIds.filter((clusterId) => !available.has(clusterId));
    if (unknown.length > 0) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Finalist scope references unknown current cluster(s) for enrichment ${gate.enrichmentId}: ${unknown.join(', ')}`,
      );
    }
  }

  const continuation = deps.resolveContinuation(
    selection.mode === 'all'
      ? {
          version: 1,
          researchId: gate.researchId,
          action: { type: 'finalists_all' },
        }
      : {
          version: 1,
          researchId: gate.researchId,
          action: { type: 'finalists', clusters: [...selection.clusterIds] },
        },
    join(process.cwd(), '.runner-ui-finalist-scope.json'),
  );

  const baseWorkflowDeps = options.workflowDeps ?? DEFAULT_RESEARCH_RUN_DEPS;
  const guardedWorkflowDeps: ResearchRunDeps = {
    ...baseWorkflowDeps,
    buildStatus: async (input) => {
      const status = await baseWorkflowDeps.buildStatus(input);
      if (
        status.researchId !== gate.researchId
        || status.discovery.runId !== gate.discoveryRunId
        || status.currentEnrichmentId !== selection.enrichmentId
        || status.finalization.state !== 'not_started'
      ) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `Finalist scope selection is stale: expected research ${gate.researchId}, discovery ${gate.discoveryRunId}, enrichment ${selection.enrichmentId}, finalization not_started; current state is research ${status.researchId}, discovery ${status.discovery.runId}, enrichment ${status.currentEnrichmentId ?? 'none'}, finalization ${status.finalization.state}. Reload current finalist scope.`,
        );
      }
      return status;
    },
  };

  return deps.executeExistingResearch(gate.researchId, continuation, {
    outputRoot: options.outputRoot ?? null,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    deps: guardedWorkflowDeps,
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    manageProcessSignals: false,
  });
}

export function validateResearchFinalistScopeSelection(value: unknown): ResearchFinalistScopeSelectionV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Finalist scope selection must be an object with version: 1.');
  }
  const mode = value.mode;
  if (mode !== 'selected' && mode !== 'all') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Finalist scope mode must be "selected" or "all".');
  }
  const allowed = mode === 'selected'
    ? new Set(['version', 'enrichmentId', 'mode', 'clusterIds'])
    : new Set(['version', 'enrichmentId', 'mode']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown finalist scope selection field: ${key}.`);
    }
  }

  const enrichmentId = requiredExactString(value.enrichmentId, 'enrichmentId');
  if (mode === 'all') return { version: 1, enrichmentId, mode: 'all' };

  if (!Array.isArray(value.clusterIds) || value.clusterIds.some((item) => typeof item !== 'string')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'clusterIds must be an array of strings.');
  }
  const clusterIds = value.clusterIds.map((clusterId, index) => requiredExactString(clusterId, `clusterIds[${index}]`));
  if (clusterIds.length === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Explicit finalist scope must contain at least one cluster id.');
  }
  if (new Set(clusterIds).size !== clusterIds.length) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Explicit finalist scope cluster ids must be unique.');
  }
  return { version: 1, enrichmentId, mode: 'selected', clusterIds };
}

export async function loadFinalistScopeClusters(
  outputRoot: string,
  enrichmentId: string,
): Promise<ResearchFinalistClusterV1[]> {
  const location = await resolveEnrichmentLocation(outputRoot, enrichmentId);
  const store = RunStore.openReadOnly(join(location.enrichmentDirectory, 'enrichment.sqlite'));
  try {
    const run = store.loadEnrichmentRun(enrichmentId);
    if (!run) throw new ResearchError('RESUME_NOT_FOUND', `Enrichment not found: ${enrichmentId}.`);
    if (run.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Finalist scope requires a completed enrichment; ${enrichmentId} is ${run.state}.`,
      );
    }
    if (!run.modules.includes('clusters')) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${enrichmentId} did not run the clusters module.`,
      );
    }

    const clusteringConfig = run.config.clusters;
    if (
      !clusteringConfig
      || clusteringConfig.algorithmVersion !== CLUSTERING_ALGORITHM_VERSION
      || clusteringConfig.urlIdentityVersion !== CLUSTER_URL_IDENTITY_VERSION
      || clusteringConfig.groupingRule !== 'complete_link'
    ) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Finalist scope requires completed clustering ${CLUSTERING_ALGORITHM_VERSION} with URL identity ${CLUSTER_URL_IDENTITY_VERSION} and complete-link grouping. Historical clustering remains readable but cannot be selected as current finalist identity.`,
      );
    }

    const clusteringItem = store.loadEnrichmentItems(enrichmentId).find(
      (item) => item.itemId === 'clusters' && item.module === 'clusters',
    );
    if (!clusteringItem || clusteringItem.status !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${enrichmentId} has no completed clusters checkpoint.`,
      );
    }

    await assertFinalistSourceIsFresh(outputRoot, run.sourceRunId, clusteringItem.updatedAt);

    const clusters = store.loadKeywordClusters(enrichmentId);
    if (clusters.length === 0) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment ${enrichmentId} contains no clusters.`);
    }
    if (clusters.some((cluster) => cluster.canonicalKeywordIdx === null || cluster.members.some((member) => member.keywordIdx === null))) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${enrichmentId} contains historical text-owned cluster rows and cannot expose current finalist identities safely.`,
      );
    }

    return clusters.map((cluster) => ({
      clusterId: cluster.clusterId,
      canonicalKeyword: cluster.canonicalKeyword,
      memberCount: cluster.memberCount,
      medianVolume: cluster.medianVolume,
      averageVolume: cluster.averageVolume,
      representativeDomains: [...cluster.representativeDomains],
      cohesion: cluster.cohesion
        ? {
            urlJaccardMedian: cluster.cohesion.urlJaccard?.median ?? null,
            domainJaccardMedian: cluster.cohesion.domainJaccard?.median ?? null,
          }
        : null,
      members: cluster.members.map((member) => ({
        keyword: member.keyword,
        normalizedKeyword: member.normalizedKeyword,
        volume: member.volume,
        serpSize: member.serpSize,
      })),
    }));
  } finally {
    store.close();
  }
}

async function assertFinalistSourceIsFresh(
  outputRoot: string,
  sourceRunId: string,
  clusteringUpdatedAt: string,
): Promise<void> {
  const sourceLocation = await resolveRunLocation(outputRoot, sourceRunId);
  const sourceStore = RunStore.openReadOnly(join(sourceLocation.discoveryDirectory, 'run.sqlite'));
  try {
    const sourceRun = sourceStore.loadRun(sourceRunId);
    if (!sourceRun) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Source run not found: ${sourceRunId}.`);
    }
    if (sourceRun.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Source run ${sourceRunId} is ${sourceRun.state}; finalist scope requires the completed source snapshot used by clustering.`,
      );
    }
    try {
      assertRepresentativeSourceFreshness({
        sourceRunId,
        sourceUpdatedAt: sourceRun.updatedAt,
        clusteringUpdatedAt,
      });
    } catch (error) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  } finally {
    sourceStore.close();
  }
}

function requiredTrimmedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredExactString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${field} must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${field} must not contain leading or trailing whitespace.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
