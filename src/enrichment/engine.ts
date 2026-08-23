import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { writeTextAtomic } from '../runs/run.js';
import type { SerpResult } from '../google/serp.js';
import { clusterKeywords, CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig, type ClusteringInput, type ClusteringResult } from './clustering.js';
import { writeKeywordClustersCsv, writeKeywordClustersJson, writePagesCsv, writePagesJson, writeSiteStructureCsv, writeSiteStructureJson } from './outputs.js';
import type {
  EnrichmentItemSource,
  EnrichmentModuleConfig,
  EnrichmentModuleId,
  EnrichmentRunState,
  EnrichmentCacheStatus,
  EnrichmentRunRecord,
} from './types.js';
import { boundedFetch, type FetcherConfig, type SsrfChecker } from './http/fetcher.js';

export type { SsrfChecker };
import { getContentTypeKind } from './http/parse.js';
import { extractAll, resolveCanonical } from './pages/extractors.js';
import type { PageRecord, FormCounts } from './pages/types.js';
import { parseRobotsTxt, getRobotsUrl } from './site_structure/robots.js';
import { parseSitemap, sampleUrls } from './site_structure/sitemap.js';
import type { SiteStructureRecord } from './site_structure/types.js';
import { EnrichmentCache, makeCacheKey, type CacheTtlConfig } from './cache.js';

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

export type EnrichmentHttpConfig = {
  enabled: boolean;
  maxRedirects: number;
  timeoutMs: number;
  maxBytes: number;
  maxTextBytes: number;
  userAgent: string;
  respectRetryAfter: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
  baseRetryDelayMs: number;
};

export type EnrichmentPagesConfig = {
  enabled: boolean;
  topUrlsPerKeyword: number;
  includeMainText: boolean;
  mainTextMaxChars: number;
};

export type EnrichmentSiteStructureConfig = {
  enabled: boolean;
  maxSitemapFiles: number;
  maxUrlsPerSitemap: number;
  maxSampleUrls: number;
  maxDomains: number;
};

export type EnrichmentOptions = {
  enrichmentId: string;
  sourceRunId: string;
  sourceStoreOrPath: RunStore | string;
  enrichmentStore: RunStore;
  enrichmentDirectory: string;
  modules: EnrichmentModuleId[];
  shortlist?: string[];
  config: EnrichmentModuleConfig;
  httpConfig: EnrichmentHttpConfig;
  pagesConfig: EnrichmentPagesConfig;
  siteStructureConfig: EnrichmentSiteStructureConfig;
  cacheConfig?: {
    dbPath: string;
    ttl: CacheTtlConfig;
  };
  ssrfChecker?: SsrfChecker;
  logger: EnrichmentLogger;
  signal?: CancellationSignal;
  resume?: boolean;
};

export type EnrichmentModuleResult = {
  clusters?: ClusteringResult;
  pages?: PageRecord[];
  siteStructure?: SiteStructureRecord[];
  networkRequestCount?: number;
  networkErrorCount?: number;
  cacheHitCount?: number;
  cacheFreshCount?: number;
};

export type EnrichmentOutcome = {
  kind: 'completed' | 'paused' | 'failed';
  enrichmentId: string;
  state: EnrichmentRunState;
  result?: EnrichmentModuleResult;
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
    httpConfig,
    pagesConfig,
    siteStructureConfig,
    cacheConfig,
    ssrfChecker,
    logger,
    signal = NEVER_CANCELLED,
    resume = false,
  } = options;

  let sourceConn: SourceConnection | undefined;
  let cache: EnrichmentCache | undefined;

  try {
    sourceConn = openSource(sourceRunId, sourceStoreOrPath);

    if (cacheConfig) {
      cache = EnrichmentCache.open(cacheConfig);
    }

    const persistedConfig: EnrichmentModuleConfig = {
      ...config,
      http: httpConfig,
      pages: pagesConfig,
      site_structure: siteStructureConfig,
      ...(cacheConfig ? { cache: { dbPath: cacheConfig.dbPath, ttl: cacheConfig.ttl } } : {}),
      ...(shortlist ? { shortlist } : {}),
    };

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
        config: JSON.stringify(persistedConfig),
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

    const result: EnrichmentModuleResult = {};

    const networkModules = modules.filter((m) => m === 'pages' || m === 'site_structure');
    if (networkModules.length > 0 && !resume) {
      if (!shortlist || shortlist.length === 0) {
        throw new Error(`Modules ${networkModules.join(', ')} require a --shortlist of 5–30 keywords (deep selection). Got no shortlist.`);
      }
      if (shortlist.length < 5) {
        throw new Error(`Modules ${networkModules.join(', ')} require at least 5 shortlist keywords. Got ${shortlist.length}.`);
      }
      if (shortlist.length > 30) {
        throw new Error(`Modules ${networkModules.join(', ')} allow at most 30 shortlist keywords. Got ${shortlist.length}.`);
      }
    }

    if (modules.includes('clusters')) {
      const existingItem = enrichmentStore.loadEnrichmentItems(enrichmentId).find(
        (item) => item.itemId === 'clusters' && item.module === 'clusters',
      );
      if (existingItem?.status === 'completed') {
        logger('Skipping completed clusters module');
        const clusters = enrichmentStore.loadKeywordClusters(enrichmentId);
        const pairs = enrichmentStore.loadEnrichmentPairs(enrichmentId);
        const exclusions = enrichmentStore.loadEnrichmentExclusions(enrichmentId);
        result.clusters = {
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
        result.clusters = await runClustersModule(
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

    if (modules.includes('pages')) {
      const existingItem = enrichmentStore.loadEnrichmentItems(enrichmentId).find(
        (item) => item.itemId === 'pages' && item.module === 'pages',
      );
      if (existingItem?.status === 'completed') {
        logger('Skipping completed pages module');
        const batchPages = enrichmentStore.loadEnrichmentPages(enrichmentId);
        if (batchPages.length > 0) {
          result.pages = batchPages.map((p) => {
            const redirectChain: string[] = JSON.parse(p.redirectChain);
            return {
              url: p.url,
              finalUrl: p.finalUrl,
              redirectCount: p.redirectCount,
              redirectChain,
              httpStatus: p.httpStatus,
              contentType: p.contentType,
              fetchStatus: p.fetchStatus as PageRecord['fetchStatus'],
              fetchError: p.fetchError,
              fetchedAt: p.fetchedAt,
              cacheStatus: p.cacheStatus as PageRecord['cacheStatus'],
              title: p.title,
              metaDescription: p.metaDescription,
              h1: p.h1,
              canonical: p.canonical,
              language: p.language,
              wordCount: p.wordCount,
              forms: JSON.parse(p.forms) as FormCounts,
              structuredDataTypes: JSON.parse(p.structuredDataTypes) as string[],
              sourceKeywords: JSON.parse(p.sourceKeywords) as string[],
              sourcePositions: JSON.parse(p.sourcePositions) as number[],
            };
          });
        } else {
          logger('Rebuilding pages from target checkpoints (completed item, empty batch)');
          result.pages = rebuildPagesFromTargets(enrichmentStore, enrichmentId);
          enrichmentStore.saveEnrichmentPages(
            enrichmentId,
            result.pages.map((p) => ({
              url: p.url,
              finalUrl: p.finalUrl,
              redirectCount: p.redirectCount,
              redirectChain: JSON.stringify(p.redirectChain),
              httpStatus: p.httpStatus,
              contentType: p.contentType,
              fetchStatus: p.fetchStatus,
              fetchError: p.fetchError,
              fetchedAt: p.fetchedAt,
              cacheStatus: p.cacheStatus,
              title: p.title,
              metaDescription: p.metaDescription,
              h1: p.h1,
              canonical: p.canonical,
              language: p.language,
              wordCount: p.wordCount,
              forms: JSON.stringify(p.forms),
              structuredDataTypes: JSON.stringify(p.structuredDataTypes),
              sourceKeywords: JSON.stringify(p.sourceKeywords),
              sourcePositions: JSON.stringify(p.sourcePositions),
            })),
          );
        }
      } else {
        const targetStatus = enrichmentStore.getPageTargetStatus(enrichmentId);
        if (targetStatus.total > 0 && targetStatus.pending === 0) {
          logger('Skipping completed pages module (all targets done)');
          const batchPages = enrichmentStore.loadEnrichmentPages(enrichmentId);
          if (batchPages.length > 0) {
            result.pages = batchPages.map((p) => {
              const redirectChain: string[] = JSON.parse(p.redirectChain);
              return {
                url: p.url,
                finalUrl: p.finalUrl,
                redirectCount: p.redirectCount,
                redirectChain,
                httpStatus: p.httpStatus,
                contentType: p.contentType,
                fetchStatus: p.fetchStatus as PageRecord['fetchStatus'],
                fetchError: p.fetchError,
                fetchedAt: p.fetchedAt,
                cacheStatus: p.cacheStatus as PageRecord['cacheStatus'],
                title: p.title,
                metaDescription: p.metaDescription,
                h1: p.h1,
                canonical: p.canonical,
                language: p.language,
                wordCount: p.wordCount,
                forms: JSON.parse(p.forms) as FormCounts,
                structuredDataTypes: JSON.parse(p.structuredDataTypes) as string[],
                sourceKeywords: JSON.parse(p.sourceKeywords) as string[],
                sourcePositions: JSON.parse(p.sourcePositions) as number[],
              };
            });
          } else {
            logger('Rebuilding pages from target checkpoints (batch table empty)');
            const targets = enrichmentStore.loadPageTargets(enrichmentId);
            const rebuiltPages: PageRecord[] = [];
            for (const t of targets) {
              if (t.status === 'completed' && t.data) {
                try {
                  const parsed = JSON.parse(t.data) as PageRecord;
                  rebuiltPages.push({ ...parsed, cacheStatus: 'hit' });
                } catch {
                  // skip corrupted target
                }
              } else if (t.status === 'error' && t.error) {
                rebuiltPages.push({
                  url: t.url,
                  finalUrl: t.url,
                  redirectCount: 0,
                  redirectChain: [],
                  httpStatus: 0,
                  contentType: null,
                  fetchStatus: 'error',
                  fetchError: t.error,
                  fetchedAt: t.fetchedAt ?? new Date().toISOString(),
                  cacheStatus: 'none',
                  title: null,
                  metaDescription: null,
                  h1: null,
                  canonical: null,
                  language: null,
                  wordCount: null,
                  forms: { formCount: 0, textareaCount: 0, inputCount: 0, fileInputCount: 0, buttonCount: 0 },
                  structuredDataTypes: [],
                  sourceKeywords: JSON.parse(t.sourceKeywords),
                  sourcePositions: JSON.parse(t.sourcePositions),
                });
              }
            }
            result.pages = rebuiltPages;
            enrichmentStore.saveEnrichmentPages(
              enrichmentId,
              rebuiltPages.map((p) => ({
                url: p.url,
                finalUrl: p.finalUrl,
                redirectCount: p.redirectCount,
                redirectChain: JSON.stringify(p.redirectChain),
                httpStatus: p.httpStatus,
                contentType: p.contentType,
                fetchStatus: p.fetchStatus,
                fetchError: p.fetchError,
                fetchedAt: p.fetchedAt,
                cacheStatus: p.cacheStatus,
                title: p.title,
                metaDescription: p.metaDescription,
                h1: p.h1,
                canonical: p.canonical,
                language: p.language,
                wordCount: p.wordCount,
                forms: JSON.stringify(p.forms),
                structuredDataTypes: JSON.stringify(p.structuredDataTypes),
                sourceKeywords: JSON.stringify(p.sourceKeywords),
                sourcePositions: JSON.stringify(p.sourcePositions),
              })),
            );
          }
        } else {
          const pagesResult = await runPagesModule(
            enrichmentId,
            sourceConn.store,
            sourceRunId,
            httpConfig,
            pagesConfig,
            enrichmentStore,
            shortlist,
            cache,
            ssrfChecker,
            logger,
            signal,
          );
          result.pages = pagesResult.pages;
          result.networkRequestCount = (result.networkRequestCount ?? 0) + pagesResult.fetchCount;
          result.networkErrorCount = (result.networkErrorCount ?? 0) + pagesResult.errorCount;
          result.cacheHitCount = (result.cacheHitCount ?? 0) + pagesResult.cacheHits;
          result.cacheFreshCount = (result.cacheFreshCount ?? 0) + pagesResult.pages.filter((p) => p.cacheStatus === 'refreshed').length;
        }
      }
    }

    if (modules.includes('site_structure')) {
      const targetStatus = enrichmentStore.getSiteStructureTargetStatus(enrichmentId);
      if (targetStatus.total > 0 && targetStatus.pending === 0) {
        logger('Skipping completed site_structure module (all targets done)');
        const batchRecords = enrichmentStore.loadEnrichmentSiteStructure(enrichmentId);
        if (batchRecords.length > 0) {
          result.siteStructure = batchRecords.map((r) => ({
            domain: r.domain,
            homepageStatus: r.homepageStatus as SiteStructureRecord['homepageStatus'],
            homepageHttpStatus: r.homepageHttpStatus,
            robotsStatus: r.robotsStatus as SiteStructureRecord['robotsStatus'],
            robotsHttpStatus: r.robotsHttpStatus,
            robotsUrl: r.robotsUrl,
            sitemapUrlsFromRobots: r.sitemapUrlsFromRobots,
            sitemapFallbackUrl: r.sitemapFallbackUrl,
            sitemapType: r.sitemapType as SiteStructureRecord['sitemapType'],
            declaredSitemapCount: r.declaredSitemapCount,
            discoveredUrlCount: r.discoveredUrlCount,
            sampledUrls: r.sampledUrls,
            sampledUtilityUrls: r.sampledUtilityUrls,
            errors: r.errors,
            fetchedAt: r.fetchedAt,
            cacheStatus: r.cacheStatus as SiteStructureRecord['cacheStatus'],
            sourceKeywords: r.sourceKeywords,
            sourceBestPosition: r.sourceBestPosition,
          }));
        } else {
          logger('Rebuilding site structure from target checkpoints (batch table empty)');
          const targets = enrichmentStore.loadSiteStructureTargets(enrichmentId);
          const rebuiltRecords: SiteStructureRecord[] = [];
          for (const t of targets) {
            if (t.status === 'completed' && t.data) {
              try {
                const parsed = JSON.parse(t.data) as SiteStructureRecord;
                rebuiltRecords.push({ ...parsed, cacheStatus: 'hit' });
              } catch {
                // skip corrupted target
              }
            }
          }
          result.siteStructure = rebuiltRecords;
          enrichmentStore.saveEnrichmentSiteStructure(
            enrichmentId,
            rebuiltRecords.map((r) => ({
              domain: r.domain,
              homepageStatus: r.homepageStatus,
              homepageHttpStatus: r.homepageHttpStatus,
              robotsStatus: r.robotsStatus,
              robotsHttpStatus: r.robotsHttpStatus,
              robotsUrl: r.robotsUrl,
              sitemapUrlsFromRobots: JSON.stringify(r.sitemapUrlsFromRobots),
              sitemapFallbackUrl: r.sitemapFallbackUrl,
              sitemapType: r.sitemapType,
              declaredSitemapCount: r.declaredSitemapCount,
              discoveredUrlCount: r.discoveredUrlCount,
              sampledUrls: JSON.stringify(r.sampledUrls),
              sampledUtilityUrls: JSON.stringify(r.sampledUtilityUrls),
              errors: JSON.stringify(r.errors),
              fetchedAt: r.fetchedAt,
              cacheStatus: r.cacheStatus,
              sourceKeywords: JSON.stringify(r.sourceKeywords),
              sourceBestPosition: r.sourceBestPosition,
            })),
          );
        }
      } else {
        const ssResult = await runSiteStructureModule(
          enrichmentId,
          sourceConn.store,
          sourceRunId,
          httpConfig,
          siteStructureConfig,
          enrichmentStore,
          shortlist,
          cache,
          ssrfChecker,
          logger,
          signal,
        );
        result.siteStructure = ssResult.records;
        result.networkRequestCount = (result.networkRequestCount ?? 0) + ssResult.fetchCount;
        result.networkErrorCount = (result.networkErrorCount ?? 0) + ssResult.errorCount;
        result.cacheHitCount = (result.cacheHitCount ?? 0) + ssResult.cacheHits;
        result.cacheFreshCount = (result.cacheFreshCount ?? 0) + ssResult.records.filter((r) => r.cacheStatus === 'refreshed').length;
      }
    }

    if (!result.clusters && !result.pages && !result.siteStructure) {
      throw new Error('No modules executed');
    }

    if (signal.cancelled) {
      enrichmentStore.setEnrichmentState(enrichmentId, 'paused');
      return { kind: 'paused', enrichmentId, state: 'paused' };
    }

    await mkdir(enrichmentDirectory, { recursive: true });
    const artifacts: string[] = [];
    const summary: Record<string, number> = {};

    if (result.clusters) {
      const csvPath = join(enrichmentDirectory, 'keyword-clusters.csv');
      const jsonPath = join(enrichmentDirectory, 'keyword-clusters.json');

      await writeKeywordClustersCsv(csvPath, result.clusters.clusters);
      await writeKeywordClustersJson(jsonPath, {
        enrichmentId,
        sourceRunId,
        outputDirectory: enrichmentDirectory,
        clusters: result.clusters.clusters,
        pairs: result.clusters.pairs,
        exclusions: result.clusters.exclusions,
        edgeCount: result.clusters.edgeCount,
        inputCount: result.clusters.inputCount,
        excludedCount: result.clusters.excludedCount,
        algorithmVersion: result.clusters.algorithmVersion,
        config: result.clusters.config,
      });

      summary.inputCount = result.clusters.inputCount;
      summary.excludedCount = result.clusters.excludedCount;
      summary.clusterCount = result.clusters.clusters.length;
      summary.pairCount = result.clusters.pairs.length;
      summary.edgeCount = result.clusters.edgeCount;

      artifacts.push('keyword-clusters.csv', 'keyword-clusters.json');
    }

    if (result.pages) {
      const csvPath = join(enrichmentDirectory, 'pages.csv');
      const jsonPath = join(enrichmentDirectory, 'pages.json');

      await writePagesCsv(csvPath, result.pages);
      await writePagesJson(jsonPath, { enrichmentId, sourceRunId, pages: result.pages });

      summary.pageCount = result.pages.length;
      summary.pageErrorCount = result.pages.filter((p) => p.fetchStatus !== 'ok').length;
      summary.pageCacheHitCount = result.pages.filter((p) => p.cacheStatus === 'hit').length;
      summary.pageCacheFreshCount = result.pages.filter((p) => p.cacheStatus === 'refreshed').length;

      artifacts.push('pages.csv', 'pages.json');
    }

    if (result.siteStructure) {
      const csvPath = join(enrichmentDirectory, 'site-structure.csv');
      const jsonPath = join(enrichmentDirectory, 'site-structure.json');

      await writeSiteStructureCsv(csvPath, result.siteStructure);
      await writeSiteStructureJson(jsonPath, { enrichmentId, sourceRunId, records: result.siteStructure });

      summary.domainCount = result.siteStructure.length;
      summary.domainCacheHitCount = result.siteStructure.filter((r) => r.cacheStatus === 'hit').length;

      artifacts.push('site-structure.csv', 'site-structure.json');
    }

    if (result.networkRequestCount !== undefined) {
      summary.networkRequestCount = result.networkRequestCount ?? 0;
      summary.networkErrorCount = result.networkErrorCount ?? 0;
      summary.cacheHitCount = result.cacheHitCount ?? 0;
      summary.cacheFreshCount = result.cacheFreshCount ?? 0;
    }

    const manifestPath = join(enrichmentDirectory, 'manifest.json');
    const statusPath = join(enrichmentDirectory, 'status.json');
    artifacts.push('manifest.json', 'status.json');

    await writeTextAtomic(
      manifestPath,
      JSON.stringify({
        enrichmentId,
        sourceRunId,
        modules,
        config: persistedConfig,
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
    logger(`Enrichment completed: ${artifacts.filter((a) => a !== 'manifest.json' && a !== 'status.json').length} artifacts`);

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
    if (cache) {
      cache.close();
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

type UrlProvenance = {
  keywords: string[];
  positions: number[];
};

async function runPagesModule(
  enrichmentId: string,
  sourceStore: RunStore,
  sourceRunId: string,
  httpConfig: EnrichmentHttpConfig,
  pagesConfig: EnrichmentPagesConfig,
  enrichmentStore: RunStore,
  shortlist: string[] | undefined,
  cache: EnrichmentCache | undefined,
  ssrfChecker: SsrfChecker | undefined,
  logger: EnrichmentLogger,
  signal: CancellationSignal,
): Promise<{ pages: PageRecord[]; fetchCount: number; errorCount: number; cacheHits: number }> {
  const source = 'http' as EnrichmentItemSource;

  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'pages',
    module: 'pages',
    status: 'running',
    source,
    cacheStatus: 'none',
  });

  checkCancellation(signal);

  const keywords = sourceStore.loadKeywords(sourceRunId)
    .filter((k) => k.status === 'completed' || k.status === 'partial')
    .map((k) => ({
      keyword: k.keyword,
      normalizedKeyword: k.normalizedKeyword,
      keywordIdx: k.idx,
    }));

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
    selectedKeywords = keywords.filter((keyword) => shortlistSet.has(keyword.normalizedKeyword));
  }

  const urlProvenance = new Map<string, UrlProvenance>();
  for (const kw of selectedKeywords) {
    const rows = (serpRowsByKeywordIdx.get(kw.keywordIdx) ?? [])
      .filter((r) => r.resultType === 'organic')
      .slice(0, pagesConfig.topUrlsPerKeyword);

    for (const row of rows) {
      const existing = urlProvenance.get(row.url) ?? { keywords: [], positions: [] };
      existing.keywords.push(kw.keyword);
      existing.positions.push(row.position);
      urlProvenance.set(row.url, existing);
    }
  }

  const uniqueUrls = [...urlProvenance.keys()];
  logger(`Inspecting ${uniqueUrls.length} unique URLs from ${selectedKeywords.length} keywords`);

  for (const url of uniqueUrls) {
    const provenance = urlProvenance.get(url)!;
    enrichmentStore.insertPageTargetIfAbsent(enrichmentId, {
      url,
      status: 'pending',
      sourceKeywords: JSON.stringify(provenance.keywords),
      sourcePositions: JSON.stringify(provenance.positions),
    });
  }

  const existingTargets = new Map(
    enrichmentStore.loadPageTargets(enrichmentId).map((t) => [t.url, t]),
  );

  const fetcherCfg: Partial<FetcherConfig> = {
    maxRedirects: httpConfig.maxRedirects,
    timeoutMs: httpConfig.timeoutMs,
    maxBytes: httpConfig.maxBytes,
    maxTextBytes: httpConfig.maxTextBytes,
    userAgent: httpConfig.userAgent,
    respectRetryAfter: httpConfig.respectRetryAfter,
    minDomainDelayMs: httpConfig.minDelayMs,
    maxDomainDelayMs: httpConfig.maxDelayMs,
  };
  if (ssrfChecker) fetcherCfg.ssrfChecker = ssrfChecker;

  const PAGE_EXTRACTOR_VERSION = '1.0.0';
  const pages: PageRecord[] = [];
  let cacheHits = 0;
  let fetchCount = 0;
  let errorCount = 0;

  for (const url of uniqueUrls) {
    if (signal.cancelled) break;

    const existing = existingTargets.get(url);
    if (existing && existing.status === 'completed' && existing.data) {
      try {
        const parsed = JSON.parse(existing.data) as PageRecord;
        pages.push({ ...parsed, cacheStatus: 'none' });
        continue;
      } catch {
        // fall through to re-fetch
      }
    }

    const provenance = urlProvenance.get(url)!;
    const cacheKey = cache ? makeCacheKey(url, PAGE_EXTRACTOR_VERSION, String(pagesConfig.topUrlsPerKeyword)) : '';

    enrichmentStore.upsertPageTarget(enrichmentId, { url, status: 'running' });

    let page: PageRecord | undefined;

    if (cache && cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached && cache.isFresh(cached)) {
        try {
          const parsed = JSON.parse(cached.data) as PageRecord;
          page = { ...parsed, cacheStatus: 'hit', sourceKeywords: provenance.keywords, sourcePositions: provenance.positions };
          cacheHits++;
        } catch {
          // fall through to fetch
        }
      }
    }

    if (!page) {
      fetchCount++;
      const fetchResult = await boundedFetch(url, fetcherCfg);
      page = buildPageRecord(url, fetchResult, httpConfig, pagesConfig, provenance.keywords, provenance.positions);

      if (cache && cacheKey) {
        const cacheStatus = page.fetchStatus === 'ok' ? 'ok' : 'error';
        cache.set(cacheKey, url, PAGE_EXTRACTOR_VERSION, JSON.stringify({ ...page, cacheStatus: 'none' }), cacheStatus);
        page.cacheStatus = 'refreshed';
      }
    }

    if (page) {
      if (page.fetchStatus !== 'ok') errorCount++;
      pages.push(page);
      enrichmentStore.upsertPageTarget(enrichmentId, {
        url,
        status: 'completed',
        data: JSON.stringify(page),
        fetchedAt: page.fetchedAt,
        cacheStatus: page.cacheStatus,
        sourceKeywords: JSON.stringify(provenance.keywords),
        sourcePositions: JSON.stringify(provenance.positions),
      });
    } else {
      enrichmentStore.upsertPageTarget(enrichmentId, {
        url,
        status: 'error',
        error: 'No page data',
      });
    }

    checkCancellation(signal);
  }

  logger(`Pages: ${pages.length} inspected, ${cacheHits} cache hits, ${fetchCount} fetches, ${errorCount} errors`);

  const targetStatus = enrichmentStore.getPageTargetStatus(enrichmentId);
  const allDone = targetStatus.pending === 0 && targetStatus.total > 0;

  enrichmentStore.saveEnrichmentPages(
    enrichmentId,
    pages.map((p) => ({
      url: p.url,
      finalUrl: p.finalUrl,
      redirectCount: p.redirectCount,
      redirectChain: JSON.stringify(p.redirectChain),
      httpStatus: p.httpStatus,
      contentType: p.contentType,
      fetchStatus: p.fetchStatus,
      fetchError: p.fetchError,
      fetchedAt: p.fetchedAt,
      cacheStatus: p.cacheStatus,
      title: p.title,
      metaDescription: p.metaDescription,
      h1: p.h1,
      canonical: p.canonical,
      language: p.language,
      wordCount: p.wordCount,
      forms: JSON.stringify(p.forms),
      structuredDataTypes: JSON.stringify(p.structuredDataTypes),
      sourceKeywords: JSON.stringify(p.sourceKeywords),
      sourcePositions: JSON.stringify(p.sourcePositions),
    })),
  );

  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'pages',
    module: 'pages',
    status: allDone ? 'completed' : 'error',
    source,
    cacheStatus: 'none',
    fetchedAt: new Date().toISOString(),
    requestCount: fetchCount,
    error: allDone ? null : `${targetStatus.pending} targets incomplete`,
  });

  return { pages, fetchCount, errorCount, cacheHits };
}

function buildPageRecord(
  url: string,
  fetchResult: Awaited<ReturnType<typeof boundedFetch>>,
  httpConfig: EnrichmentHttpConfig,
  pagesConfig: EnrichmentPagesConfig,
  sourceKeywords: string[],
  sourcePositions: number[],
): PageRecord {
  const now = new Date().toISOString();

  if (fetchResult.error && fetchResult.status === 0) {
    const isTimeout = fetchResult.failureReason === 'timeout';
    return {
      url,
      finalUrl: url,
      redirectCount: 0,
      redirectChain: [],
      httpStatus: 0,
      contentType: null,
      fetchStatus: isTimeout ? 'timeout' : (fetchResult.failureReason === 'blocked' ? 'blocked' : 'error'),
      fetchError: fetchResult.error,
      fetchedAt: now,
      cacheStatus: 'none',
      title: null,
      metaDescription: null,
      h1: null,
      canonical: null,
      language: null,
      wordCount: null,
      forms: { formCount: 0, textareaCount: 0, inputCount: 0, fileInputCount: 0, buttonCount: 0 },
      structuredDataTypes: [],
      sourceKeywords,
      sourcePositions,
    };
  }

  if (fetchResult.bodyError || !fetchResult.body) {
    const isTimeout = fetchResult.failureReason === 'timeout';
    return {
      url,
      finalUrl: fetchResult.finalUrl,
      redirectCount: fetchResult.redirectChain.length,
      redirectChain: fetchResult.redirectChain,
      httpStatus: fetchResult.status,
      contentType: fetchResult.contentType,
      fetchStatus: isTimeout ? 'timeout' : (fetchResult.failureReason === 'oversized' ? 'oversized' : 'error'),
      fetchError: fetchResult.error,
      fetchedAt: now,
      cacheStatus: 'none',
      title: null,
      metaDescription: null,
      h1: null,
      canonical: null,
      language: null,
      wordCount: null,
      forms: { formCount: 0, textareaCount: 0, inputCount: 0, fileInputCount: 0, buttonCount: 0 },
      structuredDataTypes: [],
      sourceKeywords,
      sourcePositions,
    };
  }

  if (fetchResult.status >= 400) {
    return {
      url,
      finalUrl: fetchResult.finalUrl,
      redirectCount: fetchResult.redirectChain.length,
      redirectChain: fetchResult.redirectChain,
      httpStatus: fetchResult.status,
      contentType: fetchResult.contentType,
      fetchStatus: 'error',
      fetchError: `HTTP ${fetchResult.status}`,
      fetchedAt: now,
      cacheStatus: 'none',
      title: null,
      metaDescription: null,
      h1: null,
      canonical: null,
      language: null,
      wordCount: null,
      forms: { formCount: 0, textareaCount: 0, inputCount: 0, fileInputCount: 0, buttonCount: 0 },
      structuredDataTypes: [],
      sourceKeywords,
      sourcePositions,
    };
  }

  const kind = getContentTypeKind(fetchResult.contentType);
  if (kind !== 'html' && kind !== 'text') {
    return {
      url,
      finalUrl: fetchResult.finalUrl,
      redirectCount: fetchResult.redirectChain.length,
      redirectChain: fetchResult.redirectChain,
      httpStatus: fetchResult.status,
      contentType: fetchResult.contentType,
      fetchStatus: 'non_html',
      fetchError: `Non-HTML content type: ${fetchResult.contentType ?? 'unknown'}`,
      fetchedAt: now,
      cacheStatus: 'none',
      title: null,
      metaDescription: null,
      h1: null,
      canonical: null,
      language: null,
      wordCount: null,
      forms: { formCount: 0, textareaCount: 0, inputCount: 0, fileInputCount: 0, buttonCount: 0 },
      structuredDataTypes: [],
      sourceKeywords,
      sourcePositions,
    };
  }

  const extracted = extractAll(fetchResult.body);

  return {
    url,
    finalUrl: fetchResult.finalUrl,
    redirectCount: fetchResult.redirectChain.length,
    redirectChain: fetchResult.redirectChain,
    httpStatus: fetchResult.status,
    contentType: fetchResult.contentType,
    fetchStatus: 'ok',
    fetchError: null,
    fetchedAt: now,
    cacheStatus: 'none',
    ...extracted,
    canonical: resolveCanonical(extracted.canonical, fetchResult.finalUrl),
    sourceKeywords,
    sourcePositions,
  };
}

async function runSiteStructureModule(
  enrichmentId: string,
  sourceStore: RunStore,
  sourceRunId: string,
  httpConfig: EnrichmentHttpConfig,
  siteStructureConfig: EnrichmentSiteStructureConfig,
  enrichmentStore: RunStore,
  shortlist: string[] | undefined,
  cache: EnrichmentCache | undefined,
  ssrfChecker: SsrfChecker | undefined,
  logger: EnrichmentLogger,
  signal: CancellationSignal,
): Promise<{ records: SiteStructureRecord[]; fetchCount: number; errorCount: number; cacheHits: number }> {
  const source = 'http' as EnrichmentItemSource;

  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'site_structure',
    module: 'site_structure',
    status: 'running',
    source,
    cacheStatus: 'none',
  });

  checkCancellation(signal);

  const keywords = sourceStore.loadKeywords(sourceRunId)
    .filter((k) => k.status === 'completed' || k.status === 'partial')
    .map((k) => ({
      keyword: k.keyword,
      keywordIdx: k.idx,
    }));

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
    selectedKeywords = keywords.filter((kw) => shortlistSet.has(normalizeKeyword(kw.keyword)));
  }

  const domainProvenance = new Map<string, { keywords: string[]; bestPosition: number }>();
  for (const kw of selectedKeywords) {
    const rows = serpRowsByKeywordIdx.get(kw.keywordIdx) ?? [];
    for (const row of rows) {
      if (row.registrableDomain) {
        const existing = domainProvenance.get(row.registrableDomain);
        if (existing) {
          existing.keywords.push(kw.keyword);
          if (row.position < existing.bestPosition) {
            existing.bestPosition = row.position;
          }
        } else {
          domainProvenance.set(row.registrableDomain, {
            keywords: [kw.keyword],
            bestPosition: row.position,
          });
        }
      }
    }
  }

  const allDomains = [...domainProvenance.keys()];
  const domains = allDomains.slice(0, siteStructureConfig.maxDomains);
  const omittedDomains = allDomains.slice(siteStructureConfig.maxDomains);

  logger(`Inspecting site structure for ${domains.length} domains (${omittedDomains.length} omitted due to maxDomains=${siteStructureConfig.maxDomains})`);

  for (const domain of domains) {
    enrichmentStore.insertSiteStructureTargetIfAbsent(enrichmentId, { domain, status: 'pending' });
  }
  for (const domain of omittedDomains) {
    enrichmentStore.upsertSiteStructureTarget(enrichmentId, {
      domain,
      status: 'error',
      error: `omitted: exceeded maxDomains=${siteStructureConfig.maxDomains}`,
    });
  }

  const existingTargets = new Map(
    enrichmentStore.loadSiteStructureTargets(enrichmentId).map((t) => [t.domain, t]),
  );

  const fetcherCfg: Partial<FetcherConfig> = {
    maxRedirects: httpConfig.maxRedirects,
    timeoutMs: httpConfig.timeoutMs,
    maxBytes: httpConfig.maxBytes,
    maxTextBytes: httpConfig.maxTextBytes,
    userAgent: httpConfig.userAgent,
    respectRetryAfter: httpConfig.respectRetryAfter,
    minDomainDelayMs: httpConfig.minDelayMs,
    maxDomainDelayMs: httpConfig.maxDelayMs,
  };
  if (ssrfChecker) fetcherCfg.ssrfChecker = ssrfChecker;

  const SITE_STRUCTURE_VERSION = '1.0.0';
  const records: SiteStructureRecord[] = [];
  let fetchCount = 0;
  let errorCount = 0;
  let cacheHits = 0;

  for (const domain of domains) {
    if (signal.cancelled) break;

    const existing = existingTargets.get(domain);
    if (existing && existing.status === 'completed' && existing.data) {
      try {
        const parsed = JSON.parse(existing.data) as SiteStructureRecord;
        records.push({ ...parsed, cacheStatus: 'none' });
        continue;
      } catch {
        // fall through to re-fetch
      }
    }

    const cacheKey = cache ? makeCacheKey(`site://${domain}`, SITE_STRUCTURE_VERSION, String(siteStructureConfig.maxSitemapFiles)) : '';

    enrichmentStore.upsertSiteStructureTarget(enrichmentId, { domain, status: 'running' });

    let record: SiteStructureRecord | undefined;

    if (cache && cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached && cache.isFresh(cached)) {
        try {
          record = JSON.parse(cached.data) as SiteStructureRecord;
          record.cacheStatus = 'hit';
          cacheHits++;
        } catch {
          // fall through to fetch
        }
      }
    }

    if (!record) {
      const provenance = domainProvenance.get(domain);
      record = await inspectDomain(
        domain,
        fetcherCfg,
        siteStructureConfig,
        provenance?.keywords ?? [],
        provenance?.bestPosition ?? null,
      );
      fetchCount++;

      if (cache && cacheKey) {
        const status = record.robotsStatus === 'error' ? 'error' : 'ok';
        cache.set(cacheKey, `site://${domain}`, SITE_STRUCTURE_VERSION, JSON.stringify({ ...record, cacheStatus: 'none' }), status);
        record.cacheStatus = 'refreshed';
      }
    }

    if (record.homepageStatus === 'error' || record.homepageStatus === 'timeout') {
      errorCount++;
    }

    records.push(record);
    enrichmentStore.upsertSiteStructureTarget(enrichmentId, {
      domain,
      status: 'completed',
      data: JSON.stringify(record),
      fetchedAt: record.fetchedAt,
      cacheStatus: record.cacheStatus,
    });

    checkCancellation(signal);
  }

  logger(`Site structure: ${records.length} domains inspected`);

  const targetStatus = enrichmentStore.getSiteStructureTargetStatus(enrichmentId);
  const allDone = targetStatus.pending === 0 && targetStatus.total > 0;

  enrichmentStore.saveEnrichmentSiteStructure(
    enrichmentId,
    records.map((r) => ({
      domain: r.domain,
      homepageStatus: r.homepageStatus,
      homepageHttpStatus: r.homepageHttpStatus,
      robotsStatus: r.robotsStatus,
      robotsHttpStatus: r.robotsHttpStatus,
      robotsUrl: r.robotsUrl,
      sitemapUrlsFromRobots: JSON.stringify(r.sitemapUrlsFromRobots),
      sitemapFallbackUrl: r.sitemapFallbackUrl,
      sitemapType: r.sitemapType,
      declaredSitemapCount: r.declaredSitemapCount,
      discoveredUrlCount: r.discoveredUrlCount,
      sampledUrls: JSON.stringify(r.sampledUrls),
      sampledUtilityUrls: JSON.stringify(r.sampledUtilityUrls),
      errors: JSON.stringify(r.errors),
      fetchedAt: r.fetchedAt,
      cacheStatus: r.cacheStatus,
      sourceKeywords: JSON.stringify(r.sourceKeywords),
      sourceBestPosition: r.sourceBestPosition,
    })),
  );

  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'site_structure',
    module: 'site_structure',
    status: allDone ? 'completed' : 'error',
    source,
    cacheStatus: 'none',
    fetchedAt: new Date().toISOString(),
    error: allDone ? null : `${targetStatus.pending} targets incomplete`,
  });

  return { records, fetchCount, errorCount, cacheHits };
}

async function inspectDomain(
  domain: string,
  fetcherCfg: Partial<FetcherConfig>,
  config: EnrichmentSiteStructureConfig,
  sourceKeywords: string[] = [],
  sourceBestPosition: number | null = null,
): Promise<SiteStructureRecord> {
  const now = new Date().toISOString();
  const errors: Array<{ url: string; error: string }> = [];

  const homepageResult = await boundedFetch(`https://${domain}/`, fetcherCfg);
  const homepageStatus: SiteStructureRecord['homepageStatus'] = homepageResult.error
    ? (homepageResult.failureReason === 'timeout' ? 'timeout' : 'error')
    : 'ok';
  const homepageHttpStatus = homepageResult.status || null;

  if (homepageResult.error) {
    errors.push({ url: `https://${domain}/`, error: homepageResult.error });
  }

  const robotsUrl = getRobotsUrl(domain);
  const robotsResult = await boundedFetch(robotsUrl, fetcherCfg);

  let robotsStatus: SiteStructureRecord['robotsStatus'] = 'not_found';
  let robotsHttpStatus = robotsResult.status || null;
  let sitemapUrlsFromRobots: string[] = [];

  if (robotsResult.error) {
    robotsStatus = robotsResult.failureReason === 'timeout' ? 'timeout' : 'error';
    errors.push({ url: robotsUrl, error: robotsResult.error });
  } else if (robotsResult.status === 404) {
    robotsStatus = 'not_found';
  } else if (robotsResult.body) {
    robotsStatus = 'ok';
    const parsed = parseRobotsTxt(robotsResult.body);
    sitemapUrlsFromRobots = parsed.sitemapUrls;
    for (const err of parsed.errors) {
      errors.push({ url: robotsUrl, error: err });
    }
  }

  let sitemapType: SiteStructureRecord['sitemapType'] = 'none';
  let declaredSitemapCount = 0;
  let discoveredUrlCount = 0;
  const allDiscoveredUrls: string[] = [];
  const sampledUtilityUrls: string[] = [];
  let sitemapFallbackUrl: string | null = null;
  let filesConsumed = 0;

  const sitemapTargets = sitemapUrlsFromRobots.length > 0
    ? sitemapUrlsFromRobots
    : [`https://${domain}/sitemap.xml`];

  if (sitemapUrlsFromRobots.length === 0) {
    sitemapFallbackUrl = `https://${domain}/sitemap.xml`;
  }

  for (const sitemapUrl of sitemapTargets) {
    if (filesConsumed >= config.maxSitemapFiles) break;

    const sitemapResult = await boundedFetch(sitemapUrl, fetcherCfg);
    filesConsumed++;

    if (sitemapResult.error || !sitemapResult.body) {
      errors.push({ url: sitemapUrl, error: sitemapResult.error ?? 'No body' });
      continue;
    }

    const parsed = parseSitemap(sitemapResult.body);
    if (parsed.error) {
      errors.push({ url: sitemapUrl, error: parsed.error });
      continue;
    }

    if (parsed.sitemapType === 'index') {
      sitemapType = 'index';
      declaredSitemapCount += parsed.sitemapUrls.length;

      for (const childUrl of parsed.sitemapUrls) {
        if (filesConsumed >= config.maxSitemapFiles) break;

        const childResult = await boundedFetch(childUrl, fetcherCfg);
        filesConsumed++;

        if (childResult.body) {
          const childParsed = parseSitemap(childResult.body);
          discoveredUrlCount += childParsed.urls.length;
          const urls = childParsed.urls.slice(0, config.maxUrlsPerSitemap);
          allDiscoveredUrls.push(...urls);
        }
      }
    } else if (parsed.sitemapType === 'urlset') {
      sitemapType = 'urlset';
      declaredSitemapCount += 1;
      discoveredUrlCount += parsed.urls.length;
      const urls = parsed.urls.slice(0, config.maxUrlsPerSitemap);
      allDiscoveredUrls.push(...urls);
    } else {
      sitemapType = 'unknown';
      discoveredUrlCount += parsed.urls.length;
      allDiscoveredUrls.push(...parsed.urls);
    }
  }

  const finalSampledUrls = sampleUrls(allDiscoveredUrls, config.maxSampleUrls);

  const utilitySlice = allDiscoveredUrls.slice(0, 20);
  for (const url of utilitySlice) {
    if (!finalSampledUrls.includes(url)) {
      sampledUtilityUrls.push(url);
    }
  }
  sampledUtilityUrls.slice(0, 10);

  return {
    domain,
    homepageStatus,
    homepageHttpStatus,
    robotsStatus,
    robotsHttpStatus,
    robotsUrl: robotsStatus === 'ok' ? robotsUrl : null,
    sitemapUrlsFromRobots,
    sitemapFallbackUrl,
    sitemapType,
    declaredSitemapCount,
    discoveredUrlCount,
    sampledUrls: finalSampledUrls,
    sampledUtilityUrls: sampledUtilityUrls.slice(0, 10),
    errors,
    fetchedAt: now,
    cacheStatus: 'none',
    sourceKeywords,
    sourceBestPosition,
  };
}

function rebuildPagesFromTargets(enrichmentStore: RunStore, enrichmentId: string): PageRecord[] {
  const targets = enrichmentStore.loadPageTargets(enrichmentId);
  const rebuiltPages: PageRecord[] = [];
  for (const t of targets) {
    if (t.status === 'completed' && t.data) {
      try {
        const parsed = JSON.parse(t.data) as PageRecord;
        rebuiltPages.push({ ...parsed, cacheStatus: 'none' });
      } catch {
        enrichmentStore.upsertPageTarget(enrichmentId, { url: t.url, status: 'error', error: 'corrupted checkpoint data' });
      }
    } else if (t.status === 'error' && t.error) {
      rebuiltPages.push({
        url: t.url,
        finalUrl: t.url,
        redirectCount: 0,
        redirectChain: [],
        httpStatus: 0,
        contentType: null,
        fetchStatus: 'error',
        fetchError: t.error,
        fetchedAt: t.fetchedAt ?? new Date().toISOString(),
        cacheStatus: 'none',
        title: null,
        metaDescription: null,
        h1: null,
        canonical: null,
        language: null,
        wordCount: null,
        forms: { formCount: 0, textareaCount: 0, inputCount: 0, fileInputCount: 0, buttonCount: 0 },
        structuredDataTypes: [],
        sourceKeywords: JSON.parse(t.sourceKeywords),
        sourcePositions: JSON.parse(t.sourcePositions),
      });
    }
  }
  return rebuiltPages;
}

function rebuildSiteStructureFromTargets(enrichmentStore: RunStore, enrichmentId: string): SiteStructureRecord[] {
  const targets = enrichmentStore.loadSiteStructureTargets(enrichmentId);
  const rebuiltRecords: SiteStructureRecord[] = [];
  for (const t of targets) {
    if (t.status === 'completed' && t.data) {
      try {
        const parsed = JSON.parse(t.data) as SiteStructureRecord;
        rebuiltRecords.push({ ...parsed, cacheStatus: 'none' });
      } catch {
        enrichmentStore.upsertSiteStructureTarget(enrichmentId, { domain: t.domain, status: 'error', error: 'corrupted checkpoint data' });
      }
    }
  }
  return rebuiltRecords;
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
