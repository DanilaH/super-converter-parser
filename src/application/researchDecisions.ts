import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { loadFinalistDecisions, type FinalistDecisionInput } from '../db/finalistDecisions.js';
import { loadRepresentativeQueryState } from '../db/representativeSets.js';
import { RunStore } from '../db/store.js';
import {
  FINALIST_BUILD_DECISION_VALUES,
  FINALIST_SEO_PRODUCT_ROLE_VALUES,
} from '../enrichment/finalistDecisionConfig.js';
import type {
  FinalistBuildDecision,
  FinalistEvidenceRow,
  FinalistSeoProductRole,
} from '../enrichment/finalistEvidence.js';
import type { FinalistEvidenceArtifact } from '../enrichment/finalistEvidenceOutputs.js';
import type { CancellationSignal } from '../enrichment/types.js';
import { resolveEnrichmentLocation, resolveOutputRoot } from '../outputs/researchLayout.js';
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

export type ResearchDecisionRecordV1 = {
  clusterId: string;
  buildDecision: FinalistBuildDecision | null;
  seoProductRole: FinalistSeoProductRole | null;
  updatedAt: string;
};

export type ResearchDecisionFinalistV1 = {
  clusterId: string;
  canonicalKeyword: string;
  representativeKeywordIds: number[];
  evidence: FinalistEvidenceRow['evidence'];
  auditFlags: FinalistEvidenceRow['auditFlags'];
  currentDecision: ResearchDecisionRecordV1 | null;
};

export type ResearchDecisionGateV1 = {
  version: 1;
  researchId: string;
  discoveryRunId: string;
  enrichmentId: string;
  representativeRevision: number;
  entrantFingerprint: string;
  decisionStateUpdatedAt: string | null;
  finalistCount: number;
  currentDecisionCount: number;
  buildDecisionValues: readonly FinalistBuildDecision[];
  seoProductRoleValues: readonly FinalistSeoProductRole[];
  finalists: ResearchDecisionFinalistV1[];
};

export type ResearchDecisionSelectionV1 = {
  version: 1;
  discoveryRunId: string;
  enrichmentId: string;
  representativeRevision: number;
  entrantFingerprint: string;
  decisionStateUpdatedAt: string | null;
  decisions: FinalistDecisionInput[];
};

type DecisionEvidenceSnapshot = Omit<ResearchDecisionGateV1, 'version' | 'researchId' | 'discoveryRunId'> & {
  sourceRunId: string;
};

export type ResearchDecisionServiceDeps = {
  buildStatus: typeof buildResearchStatusWithHistoricalPresence;
  loadProvenance: typeof readOperatorConfigProvenance;
  buildPlan: typeof buildExistingResearchPlan;
  loadDecisionEvidence: typeof loadResearchDecisionEvidence;
  resolveContinuation: typeof resolveOperatorContinuationInput;
  executeExistingResearch: typeof executeExistingResearch;
};

export const DEFAULT_RESEARCH_DECISION_DEPS: ResearchDecisionServiceDeps = {
  buildStatus: buildResearchStatusWithHistoricalPresence,
  loadProvenance: readOperatorConfigProvenance,
  buildPlan: buildExistingResearchPlan,
  loadDecisionEvidence: loadResearchDecisionEvidence,
  resolveContinuation: resolveOperatorContinuationInput,
  executeExistingResearch,
};

export type ResearchDecisionOptions = {
  outputRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  signal?: CancellationSignal;
  serviceDeps?: ResearchDecisionServiceDeps;
  workflowDeps?: ResearchRunDeps;
  runtime?: ResearchControlOptions['runtime'];
};

export async function inspectResearchDecisions(
  researchIdValue: string,
  options: Pick<ResearchDecisionOptions, 'outputRoot' | 'env' | 'serviceDeps'> = {},
): Promise<ResearchDecisionGateV1> {
  const researchId = requiredTrimmedString(researchIdValue, 'researchId');
  const env = options.env ?? process.env;
  const outputRoot = resolveOutputRoot(options.outputRoot ?? null, env);
  const deps = options.serviceDeps ?? DEFAULT_RESEARCH_DECISION_DEPS;
  const status = await deps.buildStatus({ outputRoot, targetRunId: researchId });

  if (status.legacy) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'Human decisions require a managed research with persisted OperatorConfig provenance.',
    );
  }
  const provenance = await deps.loadProvenance(status.researchDirectory);
  if (provenance === null) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${status.researchId} has no persisted OperatorConfig provenance; decisions continuation is unavailable.`,
    );
  }
  const plan = deps.buildPlan(status, null, provenance);
  if (!plan.unresolvedHumanRequirements.includes('human_decisions')) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${status.researchId} is not currently awaiting explicit human decisions.`,
    );
  }
  if (
    status.currentEnrichmentId === null
    || status.finalization.state !== 'awaiting_decisions'
    || !status.finalization.finalistMatrixPublished
  ) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${status.researchId} does not have a current finalist evidence matrix at the human-decision gate.`,
    );
  }

  const evidence = await deps.loadDecisionEvidence(
    outputRoot,
    status.researchDirectory,
    status.currentEnrichmentId,
  );
  if (evidence.sourceRunId !== status.discovery.runId) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Human-decision evidence targets discovery ${evidence.sourceRunId}, but current discovery is ${status.discovery.runId}. Reload current research state.`,
    );
  }

  return {
    version: 1,
    researchId: status.researchId,
    discoveryRunId: status.discovery.runId,
    enrichmentId: status.currentEnrichmentId,
    representativeRevision: evidence.representativeRevision,
    entrantFingerprint: evidence.entrantFingerprint,
    decisionStateUpdatedAt: evidence.decisionStateUpdatedAt,
    finalistCount: evidence.finalistCount,
    currentDecisionCount: evidence.currentDecisionCount,
    buildDecisionValues: [...evidence.buildDecisionValues],
    seoProductRoleValues: [...evidence.seoProductRoleValues],
    finalists: evidence.finalists,
  };
}

export async function executeResearchDecisionSelection(
  researchIdValue: string,
  selectionValue: unknown,
  options: ResearchDecisionOptions = {},
): Promise<ResearchRunExecution> {
  const selection = validateResearchDecisionSelection(selectionValue);
  const deps = options.serviceDeps ?? DEFAULT_RESEARCH_DECISION_DEPS;
  const gate = await inspectResearchDecisions(researchIdValue, {
    ...(options.outputRoot !== undefined ? { outputRoot: options.outputRoot } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    serviceDeps: deps,
  });
  assertSelectionLineage(selection, gate);
  assertCompleteDecisionSnapshot(selection.decisions, gate.finalists.map((finalist) => finalist.clusterId));

  const workspace = await mkdtemp(join(tmpdir(), 'runner-ui-decisions-'));
  const decisionsPath = join(workspace, 'decisions.json');
  try {
    await writeFile(decisionsPath, `${JSON.stringify(selection.decisions, null, 2)}\n`, 'utf8');
    const continuation = deps.resolveContinuation(
      {
        version: 1,
        researchId: gate.researchId,
        action: { type: 'decisions', path: './decisions.json' },
      },
      join(workspace, 'continuation.json'),
    );

    const baseWorkflowDeps = options.workflowDeps ?? DEFAULT_RESEARCH_RUN_DEPS;
    const guardedWorkflowDeps: ResearchRunDeps = {
      ...baseWorkflowDeps,
      buildStatus: async (input) => {
        const status = await baseWorkflowDeps.buildStatus(input);
        if (
          status.researchId !== gate.researchId
          || status.discovery.runId !== selection.discoveryRunId
          || status.currentEnrichmentId !== selection.enrichmentId
          || status.finalization.state !== 'awaiting_decisions'
          || !status.finalization.finalistMatrixPublished
        ) {
          throw staleSelectionError(selection, status);
        }
        const refreshed = await deps.loadDecisionEvidence(
          input.outputRoot,
          status.researchDirectory,
          selection.enrichmentId,
        );
        if (
          refreshed.sourceRunId !== selection.discoveryRunId
          || refreshed.representativeRevision !== selection.representativeRevision
          || refreshed.entrantFingerprint !== selection.entrantFingerprint
          || refreshed.decisionStateUpdatedAt !== selection.decisionStateUpdatedAt
          || !sameIds(refreshed.finalists.map((item) => item.clusterId), gate.finalists.map((item) => item.clusterId))
        ) {
          throw new ResearchError(
            'INPUT_SCHEMA_ERROR',
            'Human-decision selection is stale relative to current finalist evidence or persisted decisions. Reload the current decision gate.',
          );
        }
        return status;
      },
    };

    return await deps.executeExistingResearch(gate.researchId, continuation, {
      outputRoot: options.outputRoot ?? null,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      deps: guardedWorkflowDeps,
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
      manageProcessSignals: false,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function validateResearchDecisionSelection(value: unknown): ResearchDecisionSelectionV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Human-decision selection must be an object with version: 1.');
  }
  const allowed = new Set([
    'version',
    'discoveryRunId',
    'enrichmentId',
    'representativeRevision',
    'entrantFingerprint',
    'decisionStateUpdatedAt',
    'decisions',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown human-decision selection field: ${key}.`);
  }

  const discoveryRunId = requiredExactString(value.discoveryRunId, 'discoveryRunId');
  const enrichmentId = requiredExactString(value.enrichmentId, 'enrichmentId');
  const representativeRevision = value.representativeRevision;
  if (!Number.isInteger(representativeRevision) || (representativeRevision as number) < 1) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'representativeRevision must be a positive integer.');
  }
  const entrantFingerprint = requiredExactString(value.entrantFingerprint, 'entrantFingerprint');
  if (!/^[a-f0-9]{64}$/.test(entrantFingerprint)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'entrantFingerprint must be a lowercase 64-character hex fingerprint.');
  }
  const decisionStateUpdatedAt = nullableTimestamp(value.decisionStateUpdatedAt, 'decisionStateUpdatedAt');
  if (!Array.isArray(value.decisions)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'decisions must be an array.');
  }

  const seen = new Set<string>();
  const decisions = value.decisions.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `decisions[${index}] must be an object.`);
    }
    const rowAllowed = new Set(['clusterId', 'buildDecision', 'seoProductRole']);
    for (const key of Object.keys(raw)) {
      if (!rowAllowed.has(key)) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown decisions[${index}] field: ${key}.`);
      }
    }
    const clusterId = requiredExactString(raw.clusterId, `decisions[${index}].clusterId`);
    if (seen.has(clusterId)) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Duplicate finalist decision row for ${clusterId}.`);
    }
    seen.add(clusterId);
    return {
      clusterId,
      buildDecision: nullableBuildDecision(raw.buildDecision, `decisions[${index}].buildDecision`),
      seoProductRole: nullableSeoProductRole(raw.seoProductRole, `decisions[${index}].seoProductRole`),
    };
  });

  return {
    version: 1,
    discoveryRunId,
    enrichmentId,
    representativeRevision: representativeRevision as number,
    entrantFingerprint,
    decisionStateUpdatedAt,
    decisions,
  };
}

export async function loadResearchDecisionEvidence(
  outputRoot: string,
  _researchDirectory: string,
  enrichmentId: string,
): Promise<DecisionEvidenceSnapshot> {
  const location = await resolveEnrichmentLocation(outputRoot, enrichmentId);
  const store = RunStore.openReadOnly(join(location.enrichmentDirectory, 'enrichment.sqlite'));
  try {
    const enrichment = store.loadEnrichmentRun(enrichmentId);
    if (!enrichment) throw new ResearchError('RESUME_NOT_FOUND', `Enrichment not found: ${enrichmentId}.`);
    if (enrichment.state !== 'completed') {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Human decisions require completed enrichment ${enrichmentId}.`);
    }
    const representatives = loadRepresentativeQueryState(store, enrichmentId);
    const entrant = loadEntrantCohortState(store, enrichmentId);
    if (!representatives || !entrant) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Human decisions require current representative and entrant-cohort state for ${enrichmentId}.`,
      );
    }
    if (entrant.representativeRevision !== representatives.revision) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Human-decision parent mismatch: representative revision ${representatives.revision} != entrant revision ${entrant.representativeRevision}.`,
      );
    }
    const entrantFingerprint = entrantCohortFingerprint(entrant);
    const artifact = await readCurrentFinalistArtifact(location.enrichmentDirectory, enrichmentId);
    if (
      artifact.enrichmentId !== enrichmentId
      || artifact.sourceRunId !== enrichment.sourceRunId
      || artifact.representativeRevision !== representatives.revision
      || artifact.entrantFingerprint !== entrantFingerprint
    ) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Finalist evidence artifact for ${enrichmentId} is stale relative to current finalist lineage.`,
      );
    }

    const representativeIds = representatives.sets.map((set) => set.clusterId);
    const artifactIds = artifact.matrix.finalists.map((row) => row.clusterId);
    if (!sameIds(representativeIds, artifactIds) || artifact.matrix.finalistCount !== artifactIds.length) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Finalist evidence artifact for ${enrichmentId} does not match the current finalist scope.`,
      );
    }

    const currentDecisions = loadFinalistDecisions(store, enrichmentId)
      .filter((decision) =>
        decision.representativeRevision === representatives.revision
        && decision.entrantFingerprint === entrantFingerprint
        && (decision.buildDecision !== null || decision.seoProductRole !== null));
    const decisionsById = new Map(currentDecisions.map((decision) => [decision.clusterId, decision]));
    const decisionStateUpdatedAt = currentDecisions.length === 0
      ? null
      : currentDecisions.map((decision) => decision.updatedAt).sort().at(-1) ?? null;

    return {
      sourceRunId: enrichment.sourceRunId,
      enrichmentId,
      representativeRevision: representatives.revision,
      entrantFingerprint,
      decisionStateUpdatedAt,
      finalistCount: artifactIds.length,
      currentDecisionCount: artifactIds.filter((clusterId) => decisionsById.has(clusterId)).length,
      buildDecisionValues: [...FINALIST_BUILD_DECISION_VALUES],
      seoProductRoleValues: [...FINALIST_SEO_PRODUCT_ROLE_VALUES],
      finalists: artifact.matrix.finalists.map((row) => {
        const decision = decisionsById.get(row.clusterId) ?? null;
        return {
          clusterId: row.clusterId,
          canonicalKeyword: row.canonicalKeyword,
          representativeKeywordIds: [...row.representativeKeywordIds],
          evidence: row.evidence,
          auditFlags: [...row.auditFlags],
          currentDecision: decision === null ? null : {
            clusterId: decision.clusterId,
            buildDecision: decision.buildDecision,
            seoProductRole: decision.seoProductRole,
            updatedAt: decision.updatedAt,
          },
        };
      }),
    };
  } finally {
    store.close();
  }
}

async function readCurrentFinalistArtifact(
  enrichmentDirectory: string,
  enrichmentId: string,
): Promise<FinalistEvidenceArtifact> {
  const path = join(enrichmentDirectory, 'finalist-evidence-matrix.json');
  try {
    await access(path);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.matrix) || !Array.isArray(parsed.matrix.finalists)) {
      throw new Error('artifact shape is invalid');
    }
    return parsed as unknown as FinalistEvidenceArtifact;
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Cannot read current finalist evidence artifact for ${enrichmentId}.`,
      { cause: error },
    );
  }
}

function assertSelectionLineage(selection: ResearchDecisionSelectionV1, gate: ResearchDecisionGateV1): void {
  if (
    selection.discoveryRunId !== gate.discoveryRunId
    || selection.enrichmentId !== gate.enrichmentId
    || selection.representativeRevision !== gate.representativeRevision
    || selection.entrantFingerprint !== gate.entrantFingerprint
    || selection.decisionStateUpdatedAt !== gate.decisionStateUpdatedAt
  ) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'Human-decision selection is stale relative to current finalist evidence or persisted decisions. Reload the current decision gate.',
    );
  }
}

function assertCompleteDecisionSnapshot(decisions: FinalistDecisionInput[], finalistIds: string[]): void {
  const submitted = decisions.map((decision) => decision.clusterId);
  if (!sameIds(submitted, finalistIds)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'Human-decision submission must contain exactly one row for every current finalist. Undecided rows may keep both decision fields null.',
    );
  }
}

function staleSelectionError(
  selection: ResearchDecisionSelectionV1,
  status: Awaited<ReturnType<typeof buildResearchStatusWithHistoricalPresence>>,
): ResearchError {
  return new ResearchError(
    'INPUT_SCHEMA_ERROR',
    `Human-decision selection is stale: expected discovery ${selection.discoveryRunId}, enrichment ${selection.enrichmentId}, `
    + `awaiting_decisions with a current matrix; current discovery is ${status.discovery.runId}, enrichment ${status.currentEnrichmentId ?? 'none'}, `
    + `finalization ${status.finalization.state}, matrix current ${status.finalization.finalistMatrixPublished}. Reload the current decision gate.`,
  );
}

function nullableBuildDecision(value: unknown, field: string): FinalistBuildDecision | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(FINALIST_BUILD_DECISION_VALUES as readonly string[]).includes(value)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `${field} must be ${FINALIST_BUILD_DECISION_VALUES.join(', ')}, or null.`,
    );
  }
  return value as FinalistBuildDecision;
}

function nullableSeoProductRole(value: unknown, field: string): FinalistSeoProductRole | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !(FINALIST_SEO_PRODUCT_ROLE_VALUES as readonly string[]).includes(value)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `${field} must be ${FINALIST_SEO_PRODUCT_ROLE_VALUES.join(', ')}, or null.`,
    );
  }
  return value as FinalistSeoProductRole;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${field} must be an ISO timestamp or null.`);
  }
  return value;
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

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
