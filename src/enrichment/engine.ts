import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { writeTextAtomic } from '../runs/run.js';
import type { SerpResult } from '../google/serp.js';
import type { CacheStore } from '../cache/store.js';
import type { RdapClient } from '../rdap/types.js';
import type { FirstSeenClient } from '../firstseen/types.js';
import { clusterKeywords, CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig, type ClusteringInput, type ClusteringResult } from './clustering.js';
import { writeKeywordClustersCsv, writeKeywordClustersJson } from './outputs.js';
import {
  runDomainAgeModule,
  renderDomainAgeCsv,
  renderDomainAgeJson,
  type DomainAgeConfigSnapshot,
  type DomainAgeRecord,
} from '../runs/domainAge.js';
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
  resume?: boolean;
  /**
   * Optional research-config-scoped dependencies required only by the
   * `domain_age` module. Clusters does not need them, so they remain optional
   * to keep that path unchanged.
   */
  cacheStore?: CacheStore;
  domainAgeConfig?: DomainAgeConfigSnapshot;
  rdapClient?: RdapClient;
  firstSeenClient?: FirstSeenClient;
};

export type EnrichmentOutcome = {
  kind: 'completed' | 'paused' | 'failed';
  enrichmentId: string;
  state: EnrichmentRunState;
  result?: ClusteringResult;
  domainAgeRecords?: Map<string, DomainAgeRecord>;
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

// Collects the bounded, deduplicated set of registrable domains from a source run's
// organic SERP rows, restricted to the shortlist (TASK-014 is shortlist-only deep
// enrichment, 5-30 targets). Every keyword a domain was observed in is recorded in
// the returned provenance map so outputs stay traceable back to the ranking rows.
function collectSourceDomains(
  sourceStore: RunStore,
  sourceRunId: string,
  shortlist: string[] | undefined,
  logger: EnrichmentLogger,
): { domains: string[]; provenance: Map<string, string[]> } {
  const shortlistSet =
    shortlist && shortlist.length > 0 ? new Set(shortlist.map(normalizeKeyword)) : null;
  if (!shortlistSet) {
    logger('Domain-age: no shortlist provided; skipping domain enrichment (use --shortlist to bound targets).');
    return { domains: [], provenance: new Map() };
  }

  const keywords = sourceStore.loadKeywords(sourceRunId);
  const idxToKeyword = new Map<number, string>();
  for (const k of keywords) {
    idxToKeyword.set(k.idx, normalizeKeyword(k.normalizedKeyword ?? k.keyword));
  }

  const serpRows = sourceStore.loadSerpRows(sourceRunId);
  const domains: string[] = [];
  const provenance = new Map<string, string[]>();
  for (const row of serpRows) {
    if (row.resultType !== 'organic') continue;
    const keyword = idxToKeyword.get(row.keywordIdx ?? -1);
    if (keyword === undefined || !shortlistSet.has(keyword)) continue;
    const domain = row.registrableDomain ?? '';
    if (!domain) continue;
    if (!provenance.has(domain)) {
      provenance.set(domain, []);
      domains.push(domain);
    }
    const kws = provenance.get(domain) as string[];
    if (!kws.includes(keyword)) kws.push(keyword);
  }

  logger(`Domain-age: ${domains.length} bounded domains across ${shortlistSet.size} selected keywords.`);
  return { domains, provenance };
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
      return { kind: 'paused', enrichmentId, state: 'paused' };
    }

    enrichmentStore.setEnrichmentState(enrichmentId, 'running');
    logger(`Enrichment run ${enrichmentId} started`);
    logger(`Source run: ${sourceRunId}`);
    logger(`Modules: ${modules.join(', ')}`);

    let result: ClusteringResult | undefined;
    let domainAgeRecords: Map<string, DomainAgeRecord> | undefined;
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

    if (modules.includes('domain_age')) {
      const cacheStore = options.cacheStore;
      const domainAgeConfig = options.domainAgeConfig;
      if (!cacheStore || !domainAgeConfig) {
        throw new Error(
          "The 'domain_age' module requires cacheStore and domainAgeConfig options (CacheStore + DomainAgeConfigSnapshot).",
        );
      }
      checkCancellation(signal);
      // Shortlist-only: domains are bounded to the enrolled shortlist and carry
      // provenance (which shortlisted keywords observed each domain). On resume the
      // completion is derived from per-domain checkpoints in enrichment_items, not
      // from the mutable TTL cache.
      const { domains, provenance } = collectSourceDomains(sourceConn.store, sourceRunId, shortlist, logger);
      domainAgeRecords = await runDomainAgeModule({
        domains,
        provenance,
        cache: cacheStore,
        rdap: options.rdapClient ?? null,
        firstSeen: options.firstSeenClient ?? null,
        ttl: domainAgeConfig.ttl,
        forceRefresh: false,
        store: enrichmentStore,
        runId: enrichmentId,
        logger,
        signal,
        resume,
        now: Date.now,
        onProgress: (p) => logger(`  domain_age: ${p.cacheHits} cached / ${p.completed} done / ${p.errors} error(s) of ${p.total}`),
      });
    }

    if (!result && !domainAgeRecords) {
      throw new Error('No modules executed');
    }

    if (signal.cancelled) {
      enrichmentStore.setEnrichmentState(enrichmentId, 'paused');
      return { kind: 'paused', enrichmentId, state: 'paused' };
    }

    const csvPath = join(enrichmentDirectory, 'keyword-clusters.csv');
    const jsonPath = join(enrichmentDirectory, 'keyword-clusters.json');
    const domainAgeCsvPath = join(enrichmentDirectory, 'domain-age.csv');
    const domainAgeJsonPath = join(enrichmentDirectory, 'domain-age.json');
    const manifestPath = join(enrichmentDirectory, 'manifest.json');
    const statusPath = join(enrichmentDirectory, 'status.json');

    await mkdir(enrichmentDirectory, { recursive: true });

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
    }

    if (domainAgeRecords) {
      const records = [...domainAgeRecords.values()].sort((a, b) => a.domain.localeCompare(b.domain));
      await writeTextAtomic(domainAgeCsvPath, renderDomainAgeCsv(records), 'domain age CSV');
      await writeTextAtomic(
        domainAgeJsonPath,
        renderDomainAgeJson(records) + '\n',
        'domain age JSON',
      );
    }

    const summary = {
      ...(result
        ? {
            inputCount: result.inputCount,
            excludedCount: result.excludedCount,
            clusterCount: result.clusters.length,
            pairCount: result.pairs.length,
            edgeCount: result.edgeCount,
          }
        : {}),
      ...(domainAgeRecords ? { domainCount: domainAgeRecords.size } : {}),
    };
    const artifacts = [
      ...(result ? ['keyword-clusters.csv', 'keyword-clusters.json'] : []),
      ...(domainAgeRecords ? ['domain-age.csv', 'domain-age.json'] : []),
      'manifest.json',
      'status.json',
    ];
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
    if (result) {
      logger(
        `Enrichment completed: ${result.clusters.length} clusters from ${result.inputCount} keywords (${result.excludedCount} excluded)`,
      );
    }
    if (domainAgeRecords) {
      logger(`Domain-age: resolved ${domainAgeRecords.size} domains.`);
    }
    return {
      kind: 'completed',
      enrichmentId,
      state: 'completed',
      ...(result ? { result } : {}),
      ...(domainAgeRecords ? { domainAgeRecords } : {}),
    };
  } catch (error) {
    if (error instanceof EnrichmentCancelledError) {
      enrichmentStore.resetRunningEnrichmentItems(enrichmentId);
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
