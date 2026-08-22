import { existsSync } from 'node:fs';
import { RunStore } from '../db/store.js';
import type { SerpResult } from '../google/serp.js';
import { clusterKeywords, type ClusteringConfig, type ClusteringInput, type ClusteringResult } from './clustering.js';
import type {
  EnrichmentItemSource,
  EnrichmentModuleConfig,
  EnrichmentModuleId,
  EnrichmentRunState,
  EnrichmentCacheStatus,
} from './types.js';

export type EnrichmentLogger = (line: string) => void;

export type CancellationSignal = {
  readonly cancelled: boolean;
};

export const NEVER_CANCELLED: CancellationSignal = { cancelled: false };

export type EnrichmentOptions = {
  enrichmentId: string;
  sourceRunId: string;
  sourceStoreOrPath: RunStore | string;
  enrichmentStore: RunStore;
  enrichmentDirectory: string;
  modules: EnrichmentModuleId[];
  shortlist?: string[];
  config: EnrichmentModuleConfig;
  logger: EnrichmentLogger;
  signal?: CancellationSignal;
};

export type EnrichmentOutcome = {
  kind: 'completed' | 'paused' | 'failed';
  enrichmentId: string;
  state: EnrichmentRunState;
  result?: ClusteringResult;
  error?: string;
};

type SourceConnection = {
  store: RunStore;
};

function openSourceReadOnly(sourceRunId: string, explicitPath?: string): SourceConnection {
  const path = explicitPath ?? `runs/${sourceRunId}/run.sqlite`;
  if (!existsSync(path)) {
    throw new Error(`Source run not found: ${sourceRunId} (missing ${path})`);
  }
  const store = RunStore.openReadOnly(path);
  return { store };
}

function buildClusteringInputs(
  keywords: Array<{ keyword: string; normalizedKeyword: string; volume: number | null }>,
  serpRowsByNormalizedKeyword: Map<string, SerpResult[]>,
): ClusteringInput[] {
  const inputs: ClusteringInput[] = [];
  for (const kw of keywords) {
    const rows = serpRowsByNormalizedKeyword.get(kw.normalizedKeyword) ?? [];
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
    sourceRunId,
    sourceStoreOrPath,
    enrichmentStore,
    enrichmentDirectory,
    modules,
    shortlist,
    config,
    logger,
    signal = NEVER_CANCELLED,
  } = options;

  let sourceConn: SourceConnection | undefined;

  try {
    if (typeof sourceStoreOrPath === 'string') {
      sourceConn = openSourceReadOnly(sourceRunId, sourceStoreOrPath);
    } else {
      sourceConn = { store: sourceStoreOrPath };
    }

    if (signal.cancelled) {
      enrichmentStore.setEnrichmentState(enrichmentId, 'paused');
      return { kind: 'paused', enrichmentId, state: 'paused' };
    }

    enrichmentStore.createEnrichmentRun({
      enrichmentId,
      sourceRunId,
      modules,
      config: JSON.stringify(config),
      sourceRunDirectory: `runs/${sourceRunId}`,
      enrichmentDirectory,
      shortlistKeywords: shortlist ?? [],
    });

    enrichmentStore.setEnrichmentState(enrichmentId, 'running');
    logger(`Enrichment run ${enrichmentId} started`);
    logger(`Source run: ${sourceRunId}`);
    logger(`Modules: ${modules.join(', ')}`);

    let result: ClusteringResult | undefined;
    if (modules.includes('clusters')) {
      result = await runClustersModule(
        enrichmentId,
        sourceConn.store,
        sourceRunId,
        config.clusters ?? { topN: 10, edgeRule: { minSharedDomains: 3, minJaccard: 0.3 }, algorithmVersion: '1.0.0' },
        enrichmentStore,
        shortlist,
        logger,
        signal,
      );
      if (signal.cancelled) {
        enrichmentStore.setEnrichmentState(enrichmentId, 'paused');
        return { kind: 'paused', enrichmentId, state: 'paused' };
      }
    }

    if (!result) {
      throw new Error('No modules executed');
    }

    enrichmentStore.setEnrichmentState(enrichmentId, 'completed');
    logger(`Enrichment completed: ${result.clusters.length} clusters from ${result.inputCount} keywords (${result.excludedCount} excluded)`);

    return {
      kind: 'completed',
      enrichmentId,
      state: 'completed',
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    enrichmentStore.setEnrichmentState(enrichmentId, 'failed', message);
    logger(`Enrichment failed: ${message}`);
    return {
      kind: 'failed',
      enrichmentId,
      state: 'failed',
      error: message,
    };
  } finally {
    sourceConn?.store.close();
  }
}

async function runClustersModule(
  enrichmentId: string,
  sourceStore: RunStore,
  sourceRunId: string,
  config: ClusteringConfig,
  enrichmentStore: RunStore,
  shortlist: string[] | undefined,
  logger: EnrichmentLogger,
  signal: CancellationSignal,
): Promise<ClusteringResult> {
  const source = 'serp_overlap' as EnrichmentItemSource;
  const cacheStatus = 'none' as EnrichmentCacheStatus;

  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'clusters',
    module: 'clusters',
    status: 'running',
    source,
    cacheStatus,
  });

  if (signal.cancelled) {
    enrichmentStore.upsertEnrichmentItem({
      enrichmentId,
      itemId: 'clusters',
      module: 'clusters',
      status: 'error',
      source,
      cacheStatus,
      error: 'Cancelled',
    });
    throw new Error('Cancelled');
  }

  const keywords = sourceStore.loadKeywords(sourceRunId)
    .filter((k) => k.status === 'completed' || k.status === 'partial')
    .map((k) => ({
      keyword: k.keyword,
      normalizedKeyword: k.normalizedKeyword,
      volume: k.surfer?.volume ?? null,
    }));

  if (keywords.length === 0) {
    throw new Error(`No completed keywords with SERP data found in source run (got ${keywords.length} keywords from ${sourceRunId})`);
  }

  const serpRows = sourceStore.loadSerpRows(sourceRunId);
  const serpRowsByNormalizedKeyword = new Map<string, SerpResult[]>();
  for (const row of serpRows) {
    const existing = serpRowsByNormalizedKeyword.get(row.keyword) ?? [];
    existing.push(row);
    serpRowsByNormalizedKeyword.set(row.keyword, existing);
  }

  let inputs = buildClusteringInputs(keywords, serpRowsByNormalizedKeyword);

  if (shortlist && shortlist.length > 0) {
    const shortlistSet = new Set(shortlist.map((s) => s.trim().toLowerCase()));
    inputs = inputs.filter((i) => shortlistSet.has(i.normalizedKeyword));
  }

  if (signal.cancelled) {
    enrichmentStore.upsertEnrichmentItem({
      enrichmentId,
      itemId: 'clusters',
      module: 'clusters',
      status: 'error',
      source,
      cacheStatus,
      error: 'Cancelled',
    });
    throw new Error('Cancelled');
  }

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

  enrichmentStore.saveEnrichmentPairs(enrichmentId, result.pairs);
  enrichmentStore.saveEnrichmentExclusions(enrichmentId, result.exclusions);

  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'clusters',
    module: 'clusters',
    status: 'completed',
    source,
    cacheStatus,
    fetchedAt: new Date().toISOString(),
  });

  return result;
}
