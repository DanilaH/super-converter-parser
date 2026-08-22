import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import type { SerpResult } from '../google/serp.js';
import { clusterKeywords, CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig, type ClusteringInput, type ClusteringResult } from './clustering.js';
import { writeKeywordClustersCsv, writeKeywordClustersJson } from './outputs.js';
import type {
  EnrichmentItemSource,
  EnrichmentModuleConfig,
  EnrichmentModuleId,
  EnrichmentRunState,
  EnrichmentCacheStatus,
  EnrichmentRunRecord,
} from './types.js';

export type EnrichmentLogger = (line: string) => void;

export type CancellationSignal = {
  cancelled: boolean;
};

export const NEVER_CANCELLED: CancellationSignal = Object.freeze({ cancelled: false });

export class EnrichmentCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'EnrichmentCancelledError';
  }
}

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
  owned: boolean;
};

function openSource(sourceRunId: string, sourceStoreOrPath: RunStore | string): SourceConnection {
  if (typeof sourceStoreOrPath === 'string') {
    const path = sourceStoreOrPath;
    if (!existsSync(path)) {
      throw new Error(`Source run not found: ${sourceRunId} (missing ${path})`);
    }
    return { store: RunStore.openReadOnly(path), owned: true };
  }
  return { store: sourceStoreOrPath, owned: false };
}

function buildClusteringInputs(
  keywords: Array<{ keyword: string; normalizedKeyword: string; volume: number | null; keywordIdx: number }>,
  serpRowsByKeywordIdx: Map<number, SerpResult[]>,
): ClusteringInput[] {
  const inputs: ClusteringInput[] = [];
  for (const kw of keywords) {
    const rows = serpRowsByKeywordIdx.get(kw.keywordIdx) ?? [];
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

function normalizeForSerpLookup(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
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
    sourceConn = openSource(sourceRunId, sourceStoreOrPath);

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
      const existingItem = enrichmentStore.loadEnrichmentItems(enrichmentId).find(
        (item) => item.itemId === 'clusters' && item.module === 'clusters',
      );
      if (existingItem?.status === 'completed') {
        logger('Skipping completed clusters module');
        const clusters = enrichmentStore.loadKeywordClusters(enrichmentId);
        const pairs = enrichmentStore.loadEnrichmentPairs(enrichmentId);
        const exclusions = enrichmentStore.loadEnrichmentExclusions(enrichmentId);
        result = {
          clusters,
          pairs,
          exclusions: exclusions as ClusteringResult['exclusions'],
          config: config as ClusteringResult['config'],
          algorithmVersion: clusters[0]?.algorithmVersion ?? CLUSTERING_ALGORITHM_VERSION,
          inputCount: clusters.reduce((sum, c) => sum + c.memberCount, 0),
          excludedCount: exclusions.length,
          edgeCount: pairs.filter((p) => p.isEdge).length,
        };
      } else {
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
      }
    }

    if (!result) {
      throw new Error('No modules executed');
    }

    if (signal.cancelled) {
      enrichmentStore.setEnrichmentState(enrichmentId, 'paused');
      return { kind: 'paused', enrichmentId, state: 'paused' };
    }

    const csvPath = join(enrichmentDirectory, 'keyword-clusters.csv');
    const jsonPath = join(enrichmentDirectory, 'keyword-clusters.json');
    const manifestPath = join(enrichmentDirectory, 'manifest.json');

    await mkdir(enrichmentDirectory, { recursive: true });

    await writeKeywordClustersCsv(csvPath, result.clusters);
    await writeKeywordClustersJson(jsonPath, {
      enrichmentId,
      sourceRunId,
      outputDirectory: enrichmentDirectory,
      clusters: result.clusters,
      pairs: result.pairs,
      exclusions: result.exclusions,
      edgeCount: result.edgeCount,
      inputCount: result.inputCount,
      excludedCount: result.excludedCount,
      algorithmVersion: result.algorithmVersion,
      config: result.config,
    });
    await writeFile(
      manifestPath,
      JSON.stringify({
        enrichmentId,
        sourceRunId,
        modules,
        config,
        artifacts: ['keyword-clusters.csv', 'keyword-clusters.json', 'manifest.json'],
        state: 'completed',
      }, null, 2) + '\n',
      'utf8',
    );

    enrichmentStore.setEnrichmentState(enrichmentId, 'completed');
    logger(`Enrichment completed: ${result.clusters.length} clusters from ${result.inputCount} keywords (${result.excludedCount} excluded)`);

    return {
      kind: 'completed',
      enrichmentId,
      state: 'completed',
      result,
    };
  } catch (error) {
    if (error instanceof EnrichmentCancelledError) {
      enrichmentStore.setEnrichmentState(enrichmentId, 'paused');
      logger('Enrichment paused by user');
      return { kind: 'paused', enrichmentId, state: 'paused' };
    }
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
    if (sourceConn?.owned) {
      sourceConn.store.close();
    }
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

  checkCancellation(signal);

  const keywords = sourceStore.loadKeywords(sourceRunId)
    .filter((k) => k.status === 'completed' || k.status === 'partial')
    .map((k) => ({
      keyword: k.keyword,
      normalizedKeyword: k.normalizedKeyword,
      volume: k.surfer?.volume ?? null,
      keywordIdx: k.idx,
    }));

  if (keywords.length === 0) {
    throw new Error(`No completed keywords with SERP data found in source run (got ${keywords.length} keywords from ${sourceRunId})`);
  }

  const serpRows = sourceStore.loadSerpRows(sourceRunId);
  const serpRowsByKeywordIdx = new Map<number, SerpResult[]>();
  for (const row of serpRows) {
    const key = row.keywordIdx ?? -1;
    const existing = serpRowsByKeywordIdx.get(key) ?? [];
    existing.push(row);
    serpRowsByKeywordIdx.set(key, existing);
  }

  const keywordsWithSerp = keywords.filter((kw) => {
    const rows = serpRowsByKeywordIdx.get(kw.keywordIdx);
    return rows && rows.length > 0;
  });
  const keywordsWithoutSerp = keywords.filter((kw) => {
    const rows = serpRowsByKeywordIdx.get(kw.keywordIdx);
    return !rows || rows.length === 0;
  });

  let inputs = buildClusteringInputs(keywordsWithSerp, serpRowsByKeywordIdx);

  if (shortlist && shortlist.length > 0) {
    const shortlistSet = new Set(shortlist.map((s) => normalizeForSerpLookup(s)));
    inputs = inputs.filter((i) => shortlistSet.has(i.normalizedKeyword));
  }

  checkCancellation(signal);

  const withSerp = inputs.filter((i) => i.domains.length > 0).length;
  logger(`Clustering ${inputs.length} keywords (${withSerp} with SERP, ${inputs.length - withSerp} excluded)`);

  const result = clusterKeywords(inputs, config);
  result.excludedCount += keywordsWithoutSerp.length;
  for (const kw of keywordsWithoutSerp) {
    result.exclusions.push({
      keyword: kw.keyword,
      normalizedKeyword: kw.normalizedKeyword,
      reason: 'no_serp',
      serpSize: 0,
    });
  }

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

function checkCancellation(signal: CancellationSignal): void {
  if (signal.cancelled) {
    throw new EnrichmentCancelledError();
  }
}

export function loadEnrichmentForResume(
  enrichmentStore: RunStore,
  enrichmentId: string,
): EnrichmentRunRecord | null {
  return enrichmentStore.loadEnrichmentRun(enrichmentId);
}
