import type { RunStore } from '../db/store.js';
import type { SerpResult } from '../google/serp.js';
import { clusterKeywords, CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig, type ClusteringInput, type ClusteringResult } from './clustering.js';
import type { EnrichmentRunState } from './types.js';

export type EnrichmentLogger = (line: string) => void;

export type EnrichmentOptions = {
  enrichmentId: string;
  sourceStore: RunStore;
  sourceRunId: string;
  sourceRunDirectory: string;
  enrichmentStore: RunStore;
  enrichmentDirectory: string;
  modules: string[];
  config: ClusteringConfig;
  logger: EnrichmentLogger;
};

export type EnrichmentOutcome = {
  kind: 'completed' | 'failed';
  enrichmentId: string;
  state: EnrichmentRunState;
  result: ClusteringResult;
  error?: string;
};

function buildClusteringInputs(
  keywords: Array<{ keyword: string; normalizedKeyword: string; volume: number | null }>,
  serpRowsByKeyword: Map<string, SerpResult[]>,
): ClusteringInput[] {
  const inputs: ClusteringInput[] = [];
  for (const kw of keywords) {
    const rows = serpRowsByKeyword.get(kw.normalizedKeyword) ?? [];
    const domains = [...new Set(rows
      .filter((r) => r.resultType === 'organic')
      .sort((a, b) => a.position - b.position)
      .map((r) => r.registrableDomain)
      .filter((d) => d !== ''))];
    inputs.push({
      keyword: kw.keyword,
      normalizedKeyword: kw.normalizedKeyword,
      volume: kw.volume,
      domains,
    });
  }
  return inputs;
}

export async function runEnrichment(options: EnrichmentOptions): Promise<EnrichmentOutcome> {
  const {
    enrichmentId,
    sourceStore,
    sourceRunId,
    sourceRunDirectory,
    enrichmentStore,
    enrichmentDirectory,
    modules,
    config,
    logger,
  } = options;

  try {
    enrichmentStore.createEnrichmentRun({
      enrichmentId,
      sourceRunId,
      modules,
      config: JSON.stringify(config),
      sourceRunDirectory,
      enrichmentDirectory,
    });

    enrichmentStore.setEnrichmentState(enrichmentId, 'running');
    logger(`Enrichment run ${enrichmentId} started`);
    logger(`Source run: ${sourceRunId}`);
    logger(`Modules: ${modules.join(', ')}`);

    let result: ClusteringResult | undefined;
    if (modules.includes('clusters')) {
      result = await runClustersModule(enrichmentId, sourceStore, sourceRunId, config, enrichmentStore, logger);
    }

    enrichmentStore.setEnrichmentState(enrichmentId, 'completed');
    logger(`Enrichment completed: ${result ? `${result.clusters.length} clusters from ${result.inputCount} keywords` : 'no modules executed'}`);

    if (result) {
      return {
        kind: 'completed',
        enrichmentId,
        state: 'completed',
        result,
      };
    }
    return {
      kind: 'completed',
      enrichmentId,
      state: 'completed',
      result: { clusters: [], config, algorithmVersion: CLUSTERING_ALGORITHM_VERSION, inputCount: 0, excludedCount: 0, pairCount: 0 },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    enrichmentStore.setEnrichmentState(enrichmentId, 'failed', message);
    logger(`Enrichment failed: ${message}`);
    return {
      kind: 'failed',
      enrichmentId,
      state: 'failed',
      result: { clusters: [], config, algorithmVersion: CLUSTERING_ALGORITHM_VERSION, inputCount: 0, excludedCount: 0, pairCount: 0 },
      error: message,
    };
  }
}

async function runClustersModule(
  enrichmentId: string,
  sourceStore: RunStore,
  sourceRunId: string,
  config: ClusteringConfig,
  enrichmentStore: RunStore,
  logger: EnrichmentLogger,
): Promise<ClusteringResult> {
  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'clusters',
    module: 'clusters',
    status: 'running',
    source: 'serp_overlap',
  });

  const keywords = sourceStore.loadKeywords(sourceRunId)
    .filter((k) => k.status === 'completed' || k.status === 'partial')
    .map((k) => ({
      keyword: k.keyword,
      normalizedKeyword: k.normalizedKeyword,
      volume: k.surfer?.volume ?? null,
    }));

  if (keywords.length === 0) {
    throw new Error('No completed keywords with SERP data found in source run');
  }

  const serpRows = sourceStore.loadSerpRows(sourceRunId);
  const serpRowsByKeyword = new Map<string, SerpResult[]>();
  for (const row of serpRows) {
    const existing = serpRowsByKeyword.get(row.keyword) ?? [];
    existing.push(row);
    serpRowsByKeyword.set(row.keyword, existing);
  }

  const inputs = buildClusteringInputs(keywords, serpRowsByKeyword);
  const withSerp = inputs.filter((i) => i.domains.length > 0).length;
  logger(`Clustering ${inputs.length} keywords (${withSerp} with SERP, ${inputs.length - withSerp} excluded)`);

  const result = clusterKeywords(inputs, config);

  enrichmentStore.saveKeywordClusters(
    enrichmentId,
    result.clusters.map((c) => ({
      clusterId: c.clusterId,
      canonicalKeyword: c.canonicalKeyword,
      members: c.members,
      representativeDomains: c.representativeDomains,
      medianVolume: c.medianVolume,
      averageVolume: c.averageVolume,
      algorithmVersion: result.algorithmVersion,
      config: result.config,
    })),
  );

  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'clusters',
    module: 'clusters',
    status: 'completed',
    source: 'serp_overlap',
  });

  return result;
}
