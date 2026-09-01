import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RunStore } from '../db/store.js';
import {
  loadRepresentativeQueryHistory,
  loadRepresentativeQueryState,
  saveRepresentativeQuerySnapshot,
} from '../db/representativeSets.js';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
  resolveRunLocation,
} from '../outputs/researchLayout.js';
import {
  CLUSTERING_ALGORITHM_VERSION,
  type ClusteringResult,
} from '../enrichment/clustering.js';
import { loadPersistedClusteringRelations } from '../enrichment/clusteringSnapshot.js';
import { CLUSTER_URL_IDENTITY_VERSION } from '../enrichment/urlIdentity.js';
import { buildRepresentativeQuerySets } from '../enrichment/representativeSets.js';
import {
  parseRepresentativeOverridesJson,
  resolveRepresentativeQueriesConfig,
} from '../enrichment/representativeConfig.js';
import {
  writeRepresentativeQueriesCsv,
  writeRepresentativeQueriesJson,
} from '../enrichment/representativeOutputs.js';
import { publishRepresentativeMetadata } from '../enrichment/representativePublication.js';
import { assertRepresentativeSourceFreshness } from '../enrichment/representativeSourceFreshness.js';
import { ResearchError } from '../shared/errors.js';

export type RepresentativeRunRequest = {
  outputRoot: string;
  enrichmentId: string;
  targetCount?: number;
  overridesPath?: string;
  selectedClusterIds?: string[];
  allClusters?: boolean;
  logger?: (line: string) => void;
};

export type RepresentativeRunResult = {
  enrichmentId: string;
  sourceRunId: string;
  revision: number;
  changed: boolean;
  selectedClusterIds: string[];
  setCount: number;
  queryCount: number;
  manualOverrideCount: number;
  csvPath: string;
  jsonPath: string;
};

export async function runRepresentativeQueries(
  request: RepresentativeRunRequest,
): Promise<RepresentativeRunResult> {
  const logger = request.logger ?? ((line: string) => console.log(line));
  const enrichmentLocation = await resolveEnrichmentLocation(request.outputRoot, request.enrichmentId);
  const enrichmentStore = RunStore.open(join(enrichmentLocation.enrichmentDirectory, 'enrichment.sqlite'));
  let sourceStore: RunStore | undefined;

  try {
    const run = enrichmentStore.loadEnrichmentRun(request.enrichmentId);
    if (!run) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${request.enrichmentId}`);
    }
    if (run.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Representative queries require a completed enrichment; ${request.enrichmentId} is ${run.state}.`,
      );
    }
    if (!run.modules.includes('clusters')) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${request.enrichmentId} did not run the clusters module.`,
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
        `Representative queries require completed clustering ${CLUSTERING_ALGORITHM_VERSION} with URL identity ${CLUSTER_URL_IDENTITY_VERSION} and complete-link grouping. Historical clustering remains readable but is not retrofitted.`,
      );
    }

    const clusteringItem = enrichmentStore.loadEnrichmentItems(request.enrichmentId).find(
      (item) => item.itemId === 'clusters' && item.module === 'clusters',
    );
    if (!clusteringItem || clusteringItem.status !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${request.enrichmentId} has no completed clusters checkpoint.`,
      );
    }

    const clusters = enrichmentStore.loadKeywordClusters(request.enrichmentId);
    if (clusters.length === 0) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment ${request.enrichmentId} contains no clusters.`);
    }
    if (clusters.some((cluster) => cluster.canonicalKeywordIdx === null || cluster.members.some((member) => member.keywordIdx === null))) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${request.enrichmentId} contains historical text-owned cluster rows and cannot produce representative query identities safely.`,
      );
    }
    const { pairs } = loadPersistedClusteringRelations(enrichmentStore, request.enrichmentId);

    const previousState = loadRepresentativeQueryState(enrichmentStore, request.enrichmentId);
    const selectedClusterIds = resolveSelectedClusters({
      currentClusterIds: clusters.map((cluster) => cluster.clusterId),
      previousClusterIds: previousState?.config.selectedClusterIds,
      requestedClusterIds: request.selectedClusterIds,
      allClusters: request.allClusters ?? false,
    });
    const selectedIdSet = new Set(selectedClusterIds);
    const selectedClusters = clusters.filter((cluster) => selectedIdSet.has(cluster.clusterId));
    const selectedKeywordIds = new Set(
      selectedClusters.flatMap((cluster) => cluster.members.map((member) => member.keywordIdx as number)),
    );
    const selectedPairs = pairs.filter(
      (pair) => pair.keywordAIdx !== null
        && pair.keywordBIdx !== null
        && selectedKeywordIds.has(pair.keywordAIdx)
        && selectedKeywordIds.has(pair.keywordBIdx),
    );
    const clustering: Pick<ClusteringResult, 'clusters' | 'pairs'> = {
      clusters: selectedClusters,
      pairs: selectedPairs,
    };

    const overrides = await loadOverrides(request.overridesPath);
    const representativeConfig = resolveRepresentativeQueriesConfig({
      existing: previousState?.config,
      targetCount: request.targetCount,
      overrides,
      selectedClusterIds,
    });

    const sourceLocation = await resolveRunLocation(request.outputRoot, run.sourceRunId);
    sourceStore = RunStore.openReadOnly(join(sourceLocation.discoveryDirectory, 'run.sqlite'));
    const sourceRun = sourceStore.loadRun(run.sourceRunId);
    if (!sourceRun) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Source run not found: ${run.sourceRunId}`);
    }
    if (sourceRun.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Source run ${run.sourceRunId} is ${sourceRun.state}; representative queries require the completed source snapshot used by clustering.`,
      );
    }
    try {
      assertRepresentativeSourceFreshness({
        sourceRunId: run.sourceRunId,
        sourceUpdatedAt: sourceRun.updatedAt,
        clusteringUpdatedAt: clusteringItem.updatedAt,
      });
    } catch (error) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    const sets = buildRepresentativeQuerySets({
      clusters: clustering.clusters,
      pairs: clustering.pairs,
      serpRows: sourceStore.loadSerpRows(run.sourceRunId),
      topN: clusteringConfig.topN,
      config: representativeConfig,
    });

    const saveResult = saveRepresentativeQuerySnapshot(
      enrichmentStore,
      request.enrichmentId,
      representativeConfig,
      sets,
    );
    const history = loadRepresentativeQueryHistory(enrichmentStore, request.enrichmentId);
    const previousRevision = history.find((entry) => entry.revision === saveResult.revision - 1);

    const csvPath = join(enrichmentLocation.enrichmentDirectory, 'representative-queries.csv');
    const jsonPath = join(enrichmentLocation.enrichmentDirectory, 'representative-queries.json');
    await writeRepresentativeQueriesCsv(csvPath, {
      sets,
      revision: saveResult.revision,
      previousSets: previousRevision?.sets,
    });
    await writeRepresentativeQueriesJson(jsonPath, {
      enrichmentId: request.enrichmentId,
      sourceRunId: run.sourceRunId,
      config: representativeConfig,
      sets,
      revision: saveResult.revision,
      changed: saveResult.changed,
      previousSets: previousRevision?.sets,
    });

    const queryCount = sets.reduce((sum, set) => sum + set.representativeKeywordIds.length, 0);
    const manualOverrideCount = sets.filter((set) => set.manualOverride).length;
    await publishRepresentativeMetadata({
      enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
      enrichmentId: request.enrichmentId,
      sourceRunId: run.sourceRunId,
      config: representativeConfig,
      summary: {
        revision: saveResult.revision,
        changed: saveResult.changed,
        setVersion: representativeConfig.setVersion,
        targetCount: representativeConfig.targetCount,
        setCount: sets.length,
        queryCount,
        manualOverrideCount,
      },
    });
    await archiveResearchDirectory(enrichmentLocation.researchDirectory);

    logger(
      `Representative queries: ${sets.length} finalist cluster set(s), ${queryCount} query selection(s), revision ${saveResult.revision}${saveResult.changed ? ' (new)' : ' (unchanged)'}, ${manualOverrideCount} manual override(s).`,
    );
    logger(`Finalist clusters: ${representativeConfig.selectedClusterIds.join(', ')}`);
    logger(`Artifacts: ${csvPath}, ${jsonPath}`);

    return {
      enrichmentId: request.enrichmentId,
      sourceRunId: run.sourceRunId,
      revision: saveResult.revision,
      changed: saveResult.changed,
      selectedClusterIds: [...representativeConfig.selectedClusterIds],
      setCount: sets.length,
      queryCount,
      manualOverrideCount,
      csvPath,
      jsonPath,
    };
  } finally {
    sourceStore?.close();
    enrichmentStore.close();
  }
}

async function loadOverrides(path: string | undefined) {
  if (path === undefined) return undefined;
  const absolute = resolve(path);
  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Cannot read representative override file "${path}".`,
      { cause: error },
    );
  }
  try {
    return parseRepresentativeOverridesJson(content, `Representative override file "${path}"`);
  } catch (error) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

function resolveSelectedClusters(input: {
  currentClusterIds: string[];
  previousClusterIds: string[] | undefined;
  requestedClusterIds: string[] | undefined;
  allClusters: boolean;
}): string[] {
  const current = new Set(input.currentClusterIds);
  const selected = input.allClusters
    ? input.currentClusterIds
    : input.requestedClusterIds ?? input.previousClusterIds;
  if (!selected || selected.length === 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'First representative-query run requires explicit finalist scope via --clusters <ids> or --all-clusters.',
    );
  }
  const unknown = selected.filter((clusterId) => !current.has(clusterId));
  if (unknown.length > 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Representative finalist scope references unknown current cluster(s): ${unknown.join(', ')}`,
    );
  }
  return selected;
}
