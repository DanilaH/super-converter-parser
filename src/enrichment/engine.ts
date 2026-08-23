import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { writeTextAtomic } from '../runs/run.js';
import type { SerpResult } from '../google/serp.js';
import { clusterKeywords, CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig, type ClusteringInput, type ClusteringResult } from './clustering.js';
import { writeKeywordClustersCsv, writeKeywordClustersJson } from './outputs.js';
import { CacheStore } from '../cache/store.js';
import { runQuerySuggestionsModule, createBrowserSuggestionCollector, buildQueryResultFromStore, defaultQuerySuggestionsConfig, type SuggestionCollector } from './querySuggestions.js';
import { writeQuerySuggestionsCsv, writeQuerySuggestionsJson } from './querySuggestionsOutputs.js';
import type {
  EnrichmentItemSource,
  EnrichmentModuleConfig,
  EnrichmentModuleId,
  EnrichmentRunState,
  EnrichmentCacheStatus,
  EnrichmentRunRecord,
  EnrichmentLogger,
  CancellationSignal,
  QuerySuggestionResult,
  QuerySuggestionsConfig,
} from './types.js';
import { EnrichmentCancelledError, NEVER_CANCELLED } from './types.js';

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
  resume?: boolean;
};

export type EnrichmentOutcome = {
  kind: 'completed' | 'paused' | 'failed';
  enrichmentId: string;
  state: EnrichmentRunState;
  result: ClusteringResult | undefined;
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
    resume = false,
  } = options;

  let sourceConn: SourceConnection | undefined;

  try {
    sourceConn = openSource(sourceRunId, sourceStoreOrPath);

    if (resume) {
      const existingRun = enrichmentStore.loadEnrichmentRun(enrichmentId);
      if (!existingRun) {
        throw new Error(`Enrichment not found for resume: ${enrichmentId}`);
      }
      enrichmentStore.resetRunningEnrichmentItems(enrichmentId);
    } else {
      enrichmentStore.createEnrichmentRun({
        enrichmentId,
        sourceRunId,
        modules,
        config: JSON.stringify(config),
        sourceRunDirectory: `runs/${sourceRunId}`,
        enrichmentDirectory,
        shortlistKeywords: shortlist ?? [],
      });
    }

    if (signal.cancelled) {
      enrichmentStore.resetRunningEnrichmentItems(enrichmentId);
      enrichmentStore.setEnrichmentState(enrichmentId, 'paused');
      return { kind: 'paused', enrichmentId, state: 'paused', result: undefined };
    }

    enrichmentStore.setEnrichmentState(enrichmentId, 'running');
    logger(`Enrichment run ${enrichmentId} started`);
    logger(`Source run: ${sourceRunId}`);
    logger(`Modules: ${modules.join(', ')}`);

    let result: ClusteringResult | undefined;
    let queryResult: QuerySuggestionResult | undefined;
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
          config: config.clusters ?? defaultClusteringConfig(),
          algorithmVersion: clusters[0]?.algorithmVersion ?? CLUSTERING_ALGORITHM_VERSION,
          inputCount: clusters.reduce((sum, c) => sum + c.memberCount, 0) + exclusions.length,
          excludedCount: exclusions.length,
          edgeCount: pairs.filter((p) => p.isEdge).length,
        };
      } else {
        result = await runClustersModule(
          enrichmentId,
          sourceConn.store,
          sourceRunId,
          config.clusters ?? defaultClusteringConfig(),
          enrichmentStore,
          shortlist,
          logger,
          signal,
        );
      }
    }

    if (modules.includes('query_suggestions')) {
      const existingItem = enrichmentStore.loadEnrichmentItems(enrichmentId).find(
        (item) => item.itemId === 'query_suggestions' && item.module === 'query_suggestions',
      );
      if (existingItem?.status === 'completed') {
        logger('Skipping completed query_suggestions module');
        const runConfig = sourceConn.store.loadRun(sourceRunId);
        if (!runConfig) {
          throw new Error(`Source run not found for query suggestions resume: ${sourceRunId}`);
        }
        queryResult = buildQueryResultFromStore(
          enrichmentId,
          enrichmentStore,
          config.query_suggestions ?? defaultQuerySuggestionsConfig(),
          runConfig.configSnapshot,
        );
      } else {
        const runConfig = sourceConn.store.loadRun(sourceRunId);
        if (!runConfig) {
          throw new Error(`Source run not found for query suggestions: ${sourceRunId}`);
        }
        const researchConfig = runConfig.configSnapshot;
        const cacheStore = CacheStore.open(researchConfig.cache.path);
        let collector: SuggestionCollector | undefined;
        try {
          collector = await createBrowserSuggestionCollector(
            researchConfig,
            join(enrichmentDirectory, 'debug'),
            signal,
          );
          queryResult = await runQuerySuggestionsModule({
            enrichmentId,
            sourceStore: sourceConn.store,
            enrichmentStore,
            sourceRunId,
            config: config.query_suggestions ?? defaultQuerySuggestionsConfig(),
            shortlist,
            logger,
            signal,
            collector,
            cache: cacheStore,
            researchConfig,
            debugRoot: join(enrichmentDirectory, 'debug'),
          });
        } finally {
          await collector?.close().catch(() => undefined);
          cacheStore.close();
        }
      }
    }

    if (!result && !queryResult) {
      throw new Error('No modules executed');
    }

    if (signal.cancelled) {
      enrichmentStore.setEnrichmentState(enrichmentId, 'paused');
      return { kind: 'paused', enrichmentId, state: 'paused', result: undefined };
    }

    const csvPath = join(enrichmentDirectory, 'keyword-clusters.csv');
    const jsonPath = join(enrichmentDirectory, 'keyword-clusters.json');
    const manifestPath = join(enrichmentDirectory, 'manifest.json');
    const statusPath = join(enrichmentDirectory, 'status.json');

    await mkdir(enrichmentDirectory, { recursive: true });

    const summary: Record<string, unknown> = {};
    const artifacts: string[] = ['manifest.json', 'status.json'];

    if (result) {
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
      summary.inputCount = result.inputCount;
      summary.excludedCount = result.excludedCount;
      summary.clusterCount = result.clusters.length;
      summary.pairCount = result.pairs.length;
      summary.edgeCount = result.edgeCount;
      artifacts.push('keyword-clusters.csv', 'keyword-clusters.json');
    }

    if (queryResult) {
      const qCsvPath = join(enrichmentDirectory, 'query-suggestions.csv');
      const qJsonPath = join(enrichmentDirectory, 'query-suggestions.json');
      const sourceRecords = enrichmentStore.loadQuerySuggestionSources(enrichmentId);
      await writeQuerySuggestionsCsv(qCsvPath, queryResult);
      await writeQuerySuggestionsJson(qJsonPath, {
        enrichmentId,
        sourceRunId,
        outputDirectory: enrichmentDirectory,
        suggestions: queryResult.suggestions,
        perSourceStatus: queryResult.perSourceStatus,
        sourceStats: queryResult.sourceStats,
        sourceRecords: sourceRecords.map((r) => ({
          normalizedParent: r.normalizedParent,
          source: r.source,
          status: r.status,
          error: r.error,
          fetchedAt: r.fetchedAt,
        })),
        inputCount: queryResult.inputCount,
        emptyCount: queryResult.emptyCount,
        errorCount: queryResult.errorCount,
        algorithmVersion: queryResult.algorithmVersion,
        config: queryResult.config,
      });
      summary.queryInputCount = queryResult.inputCount;
      summary.querySuggestionCount = queryResult.suggestions.length;
      summary.queryEmptyCount = queryResult.emptyCount;
      summary.queryErrorCount = queryResult.errorCount;
      summary.querySourceStats = queryResult.sourceStats;
      artifacts.push('query-suggestions.csv', 'query-suggestions.json');
    }

    await writeTextAtomic(
      manifestPath,
      JSON.stringify({
        enrichmentId,
        sourceRunId,
        modules,
        config,
        shortlist: shortlist ?? [],
        artifacts,
        summary,
        state: 'completed',
      }, null, 2) + '\n',
      'enrichment manifest',
    );
    await writeTextAtomic(
      statusPath,
      JSON.stringify({
        enrichmentId,
        sourceRunId,
        status: 'completed',
        modules,
        summary,
        artifacts,
      }, null, 2) + '\n',
      'enrichment status',
    );

    enrichmentStore.setEnrichmentState(enrichmentId, 'completed');
    const parts: string[] = [];
    if (result) parts.push(`${result.clusters.length} clusters from ${result.inputCount} keywords (${result.excludedCount} excluded)`);
    if (queryResult) parts.push(`${queryResult.suggestions.length} query suggestions from ${queryResult.inputCount} keywords (${queryResult.emptyCount} empty, ${queryResult.errorCount} errors)`);
    logger(`Enrichment completed: ${parts.join('; ')}`);

    return {
      kind: 'completed',
      enrichmentId,
      state: 'completed',
      result,
    };
  } catch (error) {
    if (error instanceof EnrichmentCancelledError) {
      enrichmentStore.resetRunningEnrichmentItems(enrichmentId);
      enrichmentStore.setEnrichmentState(enrichmentId, 'paused');
      logger('Enrichment paused by user');
      return { kind: 'paused', enrichmentId, state: 'paused', result: undefined };
    }
    const message = error instanceof Error ? error.message : String(error);
    enrichmentStore.setEnrichmentState(enrichmentId, 'failed', message);
    logger(`Enrichment failed: ${message}`);
    return {
      kind: 'failed',
      enrichmentId,
      state: 'failed',
      result: undefined,
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

  let selectedKeywords = keywords;
  if (shortlist && shortlist.length > 0) {
    const shortlistSet = new Set(shortlist.map(normalizeKeyword));
    const available = new Set(keywords.map((keyword) => keyword.normalizedKeyword));
    const rejected = [...shortlistSet].filter((keyword) => !available.has(keyword));
    if (rejected.length > 0) {
      throw new Error(`Shortlist keywords not found in source run: ${rejected.join(', ')}`);
    }
    selectedKeywords = keywords.filter((keyword) => shortlistSet.has(keyword.normalizedKeyword));
  }

  const keywordsWithSerp = selectedKeywords.filter((kw) => {
    const rows = serpRowsByKeywordIdx.get(kw.keywordIdx);
    return rows && rows.length > 0;
  });
  const keywordsWithoutSerp = selectedKeywords.filter((kw) => {
    const rows = serpRowsByKeywordIdx.get(kw.keywordIdx);
    return !rows || rows.length === 0;
  });

  const inputs = buildClusteringInputs(keywordsWithSerp, serpRowsByKeywordIdx);

  checkCancellation(signal);

  const withSerp = inputs.filter((i) => i.domains.length > 0).length;
  logger(`Clustering ${inputs.length} keywords (${withSerp} with SERP, ${inputs.length - withSerp} excluded)`);

  const result = clusterKeywords(inputs, config);
  await new Promise<void>((resolve) => setImmediate(resolve));
  checkCancellation(signal);

  result.inputCount += keywordsWithoutSerp.length;
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

function defaultClusteringConfig(): ClusteringConfig {
  return {
    topN: 10,
    edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
  };
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
