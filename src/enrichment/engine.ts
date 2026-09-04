import { existsSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RunStore } from '../db/store.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { writeTextAtomic } from '../runs/run.js';
import type { SerpResult } from '../google/serp.js';
import { CacheStore } from '../cache/store.js';
import type { RdapClient } from '../rdap/types.js';
import type { FirstSeenClient } from '../firstseen/types.js';
import { resolveDrThresholds } from '../scoring/scoring.js';
import {
  clusterKeywords,
  CLUSTERING_ALGORITHM_VERSION,
  DEFAULT_CLUSTER_MIN_SHARED_URLS,
  DEFAULT_CLUSTER_MIN_URL_JACCARD,
  type ClusteringConfig,
  type ClusteringInput,
  type ClusteringResult,
} from './clustering.js';
import { loadPersistedClusteringRelations } from './clusteringSnapshot.js';
import { CLUSTER_URL_IDENTITY_VERSION, clusteringUrlIdentity } from './urlIdentity.js';
import { writeKeywordClustersCsv, writeKeywordClustersJson, writePagesCsv, writePagesJson, writeSiteStructureCsv, writeSiteStructureJson } from './outputs.js';
import {
  runDomainAgeModule,
  renderDomainAgeCsv,
  renderDomainAgeJson,
  type DomainAgeConfigSnapshot,
  type DomainAgeRecord,
} from '../runs/domainAge.js';
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
  DomainSelectionConfig,
} from './types.js';
import { EnrichmentCancelledError, NEVER_CANCELLED } from './types.js';
import { boundedFetch, type FetcherConfig, type SsrfChecker } from './http/fetcher.js';

export type { SsrfChecker };
import { getContentTypeKind } from './http/parse.js';
import { extractAll, resolveCanonical } from './pages/extractors.js';
import type { PageRecord, FormCounts } from './pages/types.js';
import { parseRobotsTxt, getRobotsUrl } from './site_structure/robots.js';
import { parseSitemap, sampleUrls } from './site_structure/sitemap.js';
import type { SiteStructureRecord } from './site_structure/types.js';
import { EnrichmentCache, makeCacheKey, type CacheTtlConfig } from './cache.js';
import {
  DOMAIN_SELECTION_POLICY_V1,
  selectDomainsEntrantAware,
  selectDomainsFairly,
  type DomainObservation,
  type FairDomainSelection,
} from './domainSelection.js';

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

export type EnrichmentModuleResult = {
  clusters?: ClusteringResult;
  pages?: PageRecord[];
  siteStructure?: SiteStructureRecord[];
  networkRequestsThisRun?: number;
  networkErrorsThisRun?: number;
  cachedSuccesses?: number;
  cachedErrors?: number;
};

export type EnrichmentOutcome = {
  kind: 'completed' | 'paused' | 'failed';
  enrichmentId: string;
  state: EnrichmentRunState;
  result?: EnrichmentModuleResult;
  domainAgeRecords?: Map<string, DomainAgeRecord>;
  error?: string;
};

const NO_RESULT: EnrichmentModuleResult = {};

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
    const organicRows = (serpRowsByKeywordIdx.get(kw.keywordIdx) ?? [])
      .filter((row) => row.resultType === 'organic')
      .sort((a, b) => a.position - b.position);
    inputs.push({
      keywordIdx: kw.keywordIdx,
      keyword: kw.keyword,
      normalizedKeyword: kw.normalizedKeyword,
      volume: kw.volume,
      domains: organicRows.map((row) => row.registrableDomain ?? ''),
      urls: organicRows.map((row) => row.url),
    });
  }
  return inputs;
}

function compareClusterIds(a: string, b: string): number {
  const aMatch = /^cluster-(\d+)$/.exec(a);
  const bMatch = /^cluster-(\d+)$/.exec(b);
  if (aMatch && bMatch) {
    const numeric = Number(aMatch[1]) - Number(bMatch[1]);
    if (numeric !== 0) return numeric;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

const DOMAIN_AGE_MIN_SHORTLIST = 5;
const DOMAIN_AGE_MAX_DOMAINS = 30;

type CollectedDomains = {
  domains: string[];
  provenance: Map<string, string[]>;
  ranks: Map<string, Array<{ keyword: string; position: number }>>;
  omitted: Array<{ domain: string; sourceKeywords: string[]; sourceRanks: Array<{ keyword: string; position: number }> }>;
};

function selectBoundedEvidenceDomains(
  sourceStore: RunStore,
  sourceRunId: string,
  keywordOrder: readonly string[],
  observations: readonly DomainObservation[],
  maxDomains: number,
  selectionConfig: DomainSelectionConfig | undefined,
): FairDomainSelection {
  if (selectionConfig === undefined) {
    return selectDomainsFairly(keywordOrder, observations, maxDomains);
  }
  if (selectionConfig.algorithmVersion !== DOMAIN_SELECTION_POLICY_V1) {
    throw new Error(`Unsupported domain-selection policy: ${selectionConfig.algorithmVersion}`);
  }
  const sourceRun = sourceStore.loadRun(sourceRunId);
  if (!sourceRun) throw new Error(`Source run not found for domain selection: ${sourceRunId}`);
  return selectDomainsEntrantAware(
    keywordOrder,
    observations,
    maxDomains,
    resolveDrThresholds(sourceRun.configSnapshot).weakMax,
  );
}

function collectSourceDomains(
  sourceStore: RunStore,
  sourceRunId: string,
  shortlist: string[] | undefined,
  selectionConfig: DomainSelectionConfig | undefined,
  logger: EnrichmentLogger,
): CollectedDomains {
  const shortlistSet =
    shortlist && shortlist.length > 0 ? new Set(shortlist.map(normalizeKeyword)) : null;
  if (!shortlistSet) {
    throw new Error(
      `The 'domain_age' module requires a shortlist of at least ${DOMAIN_AGE_MIN_SHORTLIST} keywords. Use --shortlist to specify targets.`,
    );
  }
  if (shortlistSet.size < DOMAIN_AGE_MIN_SHORTLIST) {
    throw new Error(
      `The 'domain_age' module requires at least ${DOMAIN_AGE_MIN_SHORTLIST} shortlisted keywords (got ${shortlistSet.size}). Add more keywords to the shortlist.`,
    );
  }
  const keywords = sourceStore.loadKeywords(sourceRunId);
  const idxToKeyword = new Map<number, string>();
  for (const k of keywords) {
    idxToKeyword.set(k.idx, normalizeKeyword(k.normalizedKeyword ?? k.keyword));
  }

  const serpRows = sourceStore.loadSerpRows(sourceRunId);
  const provenance = new Map<string, string[]>();
  const ranks = new Map<string, Array<{ keyword: string; position: number }>>();
  const observations: DomainObservation[] = [];
  for (const row of serpRows) {
    if (row.resultType !== 'organic') continue;
    const keyword = idxToKeyword.get(row.keywordIdx ?? -1);
    if (keyword === undefined || !shortlistSet.has(keyword)) continue;
    const domain = row.registrableDomain ?? '';
    if (!domain) continue;
    if (!provenance.has(domain)) {
      provenance.set(domain, []);
      ranks.set(domain, []);
    }
    const kws = provenance.get(domain)!;
    if (!kws.includes(keyword)) kws.push(keyword);
    const domainRanks = ranks.get(domain);
    if (domainRanks && !domainRanks.some((r) => r.keyword === keyword && r.position === row.position)) {
      domainRanks.push({ keyword, position: row.position });
    }
    observations.push({
      keyword,
      domain,
      position: row.position,
      dr: row.dr,
      pageIdentity: clusteringUrlIdentity(row.url),
    });
  }

  const keywordOrder = [...shortlistSet];
  const selection = selectBoundedEvidenceDomains(
    sourceStore,
    sourceRunId,
    keywordOrder,
    observations,
    DOMAIN_AGE_MAX_DOMAINS,
    selectionConfig,
  );
  const omitted = selection.omitted.map((domain) => ({
    domain,
    sourceKeywords: provenance.get(domain) ?? [],
    sourceRanks: ranks.get(domain) ?? [],
  }));
  const policy = selectionConfig?.algorithmVersion ?? 'legacy-fair';

  logger(`Domain-age: ${selection.selected.length} bounded domains across ${shortlistSet.size} selected keywords using ${policy}${omitted.length > 0 ? ` (${omitted.length} omitted, cap ${DOMAIN_AGE_MAX_DOMAINS})` : ''}.`);
  return { domains: selection.selected, provenance, ranks, omitted };
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

    const clusteringConfig = modules.includes('clusters')
      ? (config.clusters ?? defaultClusteringConfig())
      : config.clusters;
    const needsBoundedDomainSelection = modules.includes('domain_age') || modules.includes('site_structure');
    const domainSelectionConfig = needsBoundedDomainSelection
      ? (resume ? config.domain_selection : config.domain_selection ?? { algorithmVersion: DOMAIN_SELECTION_POLICY_V1 })
      : config.domain_selection;
    const persistedConfig: EnrichmentModuleConfig = {
      ...config,
      ...(clusteringConfig ? { clusters: clusteringConfig } : {}),
      ...(domainSelectionConfig ? { domain_selection: domainSelectionConfig } : {}),
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
        sourceRunDirectory: typeof sourceStoreOrPath === 'string' ? dirname(sourceStoreOrPath) : `runs/${sourceRunId}`,
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
    let domainAgeRecords: Map<string, DomainAgeRecord> | undefined;
    let queryResult: QuerySuggestionResult | undefined;

    const networkModules = modules.filter((m) => m === 'pages' || m === 'site_structure');
    if (networkModules.length > 0) {
      if (!shortlist || shortlist.length === 0) {
        throw new Error(`Modules ${networkModules.join(', ')} require a --shortlist of 5–200 keywords (deep selection). Got no shortlist.`);
      }
      if (shortlist.length < 5) {
        throw new Error(`Modules ${networkModules.join(', ')} require at least 5 shortlist keywords. Got ${shortlist.length}.`);
      }
      if (shortlist.length > 200) {
        throw new Error(`Modules ${networkModules.join(', ')} allow at most 200 shortlist keywords. Got ${shortlist.length}.`);
      }
    }

    if (modules.includes('clusters')) {
      const existingItem = enrichmentStore.loadEnrichmentItems(enrichmentId).find(
        (item) => item.itemId === 'clusters' && item.module === 'clusters',
      );
      if (existingItem?.status === 'completed') {
        logger('Skipping completed clusters module');
        const clusters = enrichmentStore
          .loadKeywordClusters(enrichmentId)
          .sort((a, b) => compareClusterIds(a.clusterId, b.clusterId));
        const { pairs, exclusions } = loadPersistedClusteringRelations(
          enrichmentStore,
          enrichmentId,
        );
        result.clusters = {
          clusters,
          pairs,
          exclusions: exclusions as ClusteringResult['exclusions'],
          config: clusteringConfig ?? defaultClusteringConfig(),
          algorithmVersion:
            clusters[0]?.algorithmVersion
            ?? clusteringConfig?.algorithmVersion
            ?? CLUSTERING_ALGORITHM_VERSION,
          inputCount: clusters.reduce((sum, c) => sum + c.memberCount, 0) + exclusions.length,
          excludedCount: exclusions.length,
          edgeCount: pairs.filter((p) => p.isEdge).length,
        };
      } else {
        result.clusters = await runClustersModule(
          enrichmentId,
          sourceConn.store,
          sourceRunId,
          clusteringConfig ?? defaultClusteringConfig(),
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
      const { domains, provenance, ranks, omitted } = collectSourceDomains(
        sourceConn.store,
        sourceRunId,
        shortlist,
        domainSelectionConfig,
        logger,
      );
      domainAgeRecords = await runDomainAgeModule({
        domains,
        provenance,
        ranks,
        omitted,
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

    if (modules.includes('query_suggestions')) {
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
              possiblyJsRendered: p.possiblyJsRendered ?? false,
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
              possiblyJsRendered: p.possiblyJsRendered ?? false,
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
                possiblyJsRendered: p.possiblyJsRendered ?? false,
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
                  possiblyJsRendered: false,
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
                possiblyJsRendered: p.possiblyJsRendered ?? false,
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
          result.networkRequestsThisRun = (result.networkRequestsThisRun ?? 0) + pagesResult.fetchCount;
          result.networkErrorsThisRun = (result.networkErrorsThisRun ?? 0) + pagesResult.networkErrors;
          result.cachedSuccesses = (result.cachedSuccesses ?? 0) + pagesResult.cachedSuccesses;
          result.cachedErrors = (result.cachedErrors ?? 0) + pagesResult.cachedErrors;
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
          domainSelectionConfig,
          cache,
          ssrfChecker,
          logger,
          signal,
        );
        result.siteStructure = ssResult.records;
        result.networkRequestsThisRun = (result.networkRequestsThisRun ?? 0) + ssResult.fetchCount;
        result.networkErrorsThisRun = (result.networkErrorsThisRun ?? 0) + ssResult.networkErrors;
        result.cachedSuccesses = (result.cachedSuccesses ?? 0) + ssResult.cachedSuccesses;
        result.cachedErrors = (result.cachedErrors ?? 0) + ssResult.cachedErrors;
      }
    }

    if (!result.clusters && !result.pages && !result.siteStructure && !domainAgeRecords && !queryResult) {
      throw new Error('No modules executed');
    }

    if (signal.cancelled) {
      enrichmentStore.setEnrichmentState(enrichmentId, 'paused');
      return { kind: 'paused', enrichmentId, state: 'paused' };
    }

    await mkdir(enrichmentDirectory, { recursive: true });
    const artifacts: string[] = [];
    const summary: Record<string, number | Record<string, { ok: number; empty: number; unavailable: number; error: number }>> = {};

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
      const omitted = enrichmentStore
        .loadSiteStructureTargets(enrichmentId)
        .filter((target) => target.status === 'error' && (target.error ?? '').startsWith('omitted:'))
        .map((target) => ({ domain: target.domain, reason: 'domain_cap' }))
        .sort((a, b) => a.domain.localeCompare(b.domain));

      await writeSiteStructureCsv(csvPath, result.siteStructure, omitted);
      await writeSiteStructureJson(jsonPath, { enrichmentId, sourceRunId, records: result.siteStructure, omitted });

      const siteStructureDomainCount = result.siteStructure.length;
      summary.siteStructureDomainCount = siteStructureDomainCount;
      summary.domainCacheHitCount = result.siteStructure.filter((r) => r.cacheStatus === 'hit').length;
      summary.siteStructureOmittedCount = omitted.length;
      summary.siteStructureDiscoveredDomainCount = siteStructureDomainCount + omitted.length;
      if (!domainAgeRecords) summary.domainCount = siteStructureDomainCount;

      artifacts.push('site-structure.csv', 'site-structure.json');
    }

    if (result.networkRequestsThisRun !== undefined) {
      summary.networkRequestsThisRun = result.networkRequestsThisRun ?? 0;
      summary.networkErrorsThisRun = result.networkErrorsThisRun ?? 0;
      summary.cachedSuccesses = result.cachedSuccesses ?? 0;
      summary.cachedErrors = result.cachedErrors ?? 0;
    }

    const manifestPath = join(enrichmentDirectory, 'manifest.json');
    const statusPath = join(enrichmentDirectory, 'status.json');
    artifacts.push('manifest.json', 'status.json');

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
          parentKeywordIdx: r.parentKeywordIdx,
          normalizedParent: r.normalizedParent,
          source: r.source,
          status: r.status,
          error: r.error,
          fetchedAt: r.fetchedAt,
          cacheStatus: r.cacheStatus,
          requestCount: r.requestCount,
          market: r.market,
          hl: r.hl,
          gl: r.gl,
          parserVersion: r.parserVersion,
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

    if (domainAgeRecords) {
      const domainAgeCsvPath = join(enrichmentDirectory, 'domain-age.csv');
      const domainAgeJsonPath = join(enrichmentDirectory, 'domain-age.json');
      const records = [...domainAgeRecords.values()].sort((a, b) => a.domain.localeCompare(b.domain));
      await writeTextAtomic(domainAgeCsvPath, renderDomainAgeCsv(records), 'domain age CSV');
      await writeTextAtomic(domainAgeJsonPath, renderDomainAgeJson(records) + '\n', 'domain age JSON');
      const domainAgeDomainCount = records.filter((r) => !r.omitted).length;
      const domainAgeOmittedCount = records.filter((r) => r.omitted).length;
      summary.domainAgeDomainCount = domainAgeDomainCount;
      summary.domainAgeOmittedCount = domainAgeOmittedCount;
      summary.domainAgeDiscoveredDomainCount = records.length;
      summary.domainsWithRegistration = records.filter((r) => r.registrationDate !== null && !r.omitted).length;
      summary.domainsWithFirstSeen = records.filter((r) => r.firstSeenDate !== null && !r.omitted).length;
      summary.domainErrors = records.filter((r) => r.error !== null && !r.omitted).length;
      if (!result.siteStructure) {
        summary.domainCount = domainAgeDomainCount;
        summary.domainOmitted = domainAgeOmittedCount;
        summary.domainsDiscovered = records.length;
      }
      artifacts.push('domain-age.csv', 'domain-age.json');
    }

    const manifestContent = JSON.stringify({
      enrichmentId,
      sourceRunId,
      modules,
      config: persistedConfig,
      shortlist: shortlist ?? [],
      artifacts,
      summary,
      state: 'completed',
      capabilities: {
        implemented: ['clusters', 'query_suggestions', 'domain_age', 'pages', 'site_structure'],
        blocked: [
          { module: 'page_backlinks', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
          { module: 'organic_snapshot', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
        ],
      },
    }, null, 2) + '\n';
    const statusContent = JSON.stringify({
      enrichmentId,
      sourceRunId,
      status: 'completed',
      modules,
      summary,
      artifacts,
      capabilities: {
        implemented: ['clusters', 'query_suggestions', 'domain_age', 'pages', 'site_structure'],
        blocked: [
          { module: 'page_backlinks', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
          { module: 'organic_snapshot', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
        ],
      },
    }, null, 2) + '\n';

    await writeTextAtomic(statusPath, statusContent, 'enrichment status');
    try {
      await writeTextAtomic(manifestPath, manifestContent, 'enrichment manifest');
    } catch (error) {
      await unlink(statusPath).catch(() => undefined);
      throw error;
    }

    enrichmentStore.setEnrichmentState(enrichmentId, 'completed');
    const parts: string[] = [];
    if (result.clusters) parts.push(`${result.clusters.clusters.length} clusters from ${result.clusters.inputCount} keywords (${result.clusters.excludedCount} excluded)`);
    if (result.pages) parts.push(`${result.pages.length} pages`);
    if (result.siteStructure) {
      const omittedCount = enrichmentStore
        .loadSiteStructureTargets(enrichmentId)
        .filter((target) => target.status === 'error' && (target.error ?? '').startsWith('omitted:')).length;
      parts.push(`${result.siteStructure.length} site-structure domains inspected${omittedCount > 0 ? ` (${omittedCount} omitted)` : ''}`);
    }
    if (queryResult) parts.push(`${queryResult.suggestions.length} query suggestions from ${queryResult.inputCount} keywords (${queryResult.emptyCount} empty, ${queryResult.errorCount} errors)`);
    if (domainAgeRecords) {
      const records = [...domainAgeRecords.values()];
      const processedCount = records.filter((r) => !r.omitted).length;
      const errorCount = records.filter((r) => !r.omitted && r.error !== null).length;
      const omittedCount = records.filter((r) => r.omitted).length;
      parts.push(`${processedCount} domain-age records processed (${errorCount} errors${omittedCount > 0 ? `, ${omittedCount} omitted` : ''})`);
    }
    logger(`Enrichment completed: ${parts.join('; ')}`);
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

  const withSerp = inputs.filter((input) => input.domains.some((domain) => domain !== '')).length;
  logger(`Clustering ${inputs.length} keywords (${withSerp} with SERP, ${inputs.length - withSerp} excluded)`);

  const result = clusterKeywords(inputs, config);
  await new Promise<void>((resolve) => setImmediate(resolve));
  checkCancellation(signal);

  result.inputCount += keywordsWithoutSerp.length;
  result.excludedCount += keywordsWithoutSerp.length;
  for (const kw of keywordsWithoutSerp) {
    result.exclusions.push({
      keywordIdx: kw.keywordIdx,
      keyword: kw.keyword,
      normalizedKeyword: kw.normalizedKeyword,
      reason: 'no_serp',
      serpSize: 0,
    });
  }

  enrichmentStore.saveKeywordClusters(
    enrichmentId,
    result.clusters.map((c) => {
      if (c.canonicalKeywordIdx === null) {
        throw new Error(`Fresh cluster ${c.clusterId} is missing canonical source keyword identity.`);
      }
      if (c.cohesion === undefined || c.cohesion === null) {
        throw new Error(`Fresh cluster ${c.clusterId} is missing clustering-v2 cohesion evidence.`);
      }
      const members = c.members.map((member) => {
        if (member.keywordIdx === null) {
          throw new Error(`Fresh cluster ${c.clusterId} contains a member without source keyword identity.`);
        }
        return { ...member, keywordIdx: member.keywordIdx };
      });
      return {
        clusterId: c.clusterId,
        canonicalKeywordIdx: c.canonicalKeywordIdx,
        canonicalKeyword: c.canonicalKeyword,
        members,
        representativeDomains: c.representativeDomains,
        medianVolume: c.medianVolume,
        averageVolume: c.averageVolume,
        cohesion: c.cohesion,
        algorithmVersion: result.algorithmVersion,
        config: result.config,
      };
    }),
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
): Promise<{ pages: PageRecord[]; fetchCount: number; networkErrors: number; cachedSuccesses: number; cachedErrors: number }> {
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
    maxRetries: httpConfig.maxRetries,
    baseRetryDelayMs: httpConfig.baseRetryDelayMs,
  };
  if (ssrfChecker) fetcherCfg.ssrfChecker = ssrfChecker;

  const PAGE_EXTRACTOR_VERSION = '1.1.0';
  const pages: PageRecord[] = [];
  let fetchCount = 0;
  let networkErrors = 0;
  let cachedSuccesses = 0;
  let cachedErrors = 0;

  for (const url of uniqueUrls) {
    if (signal.cancelled) break;

    const existing = existingTargets.get(url);
    if (existing && existing.status === 'completed' && existing.data) {
      try {
        const parsed = JSON.parse(existing.data) as PageRecord;
        pages.push({ ...parsed, cacheStatus: 'none' });
        continue;
      } catch {
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
          if (page.fetchStatus === 'ok') cachedSuccesses += 1;
          else cachedErrors += 1;
        } catch {
        }
      }
    }

    if (!page) {
      fetchCount++;
      const fetchResult = await boundedFetch(url, fetcherCfg);
      page = buildPageRecord(url, fetchResult, httpConfig, pagesConfig, provenance.keywords, provenance.positions);
      if (page.fetchStatus !== 'ok') networkErrors += 1;

      if (cache && cacheKey) {
        const cacheStatus = page.fetchStatus === 'ok' ? 'ok' : 'error';
        cache.set(cacheKey, url, PAGE_EXTRACTOR_VERSION, JSON.stringify({ ...page, cacheStatus: 'none' }), cacheStatus);
        page.cacheStatus = 'refreshed';
      }
    }

    if (page) {
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

  logger(`Pages: ${pages.length} inspected, ${fetchCount} network requests / ${networkErrors} network errors, ${cachedSuccesses} cached successes / ${cachedErrors} cached errors`);

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
      possiblyJsRendered: p.possiblyJsRendered ?? false,
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

  return { pages, fetchCount, networkErrors, cachedSuccesses, cachedErrors };
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
      possiblyJsRendered: false,
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
      possiblyJsRendered: false,
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
      possiblyJsRendered: false,
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
      possiblyJsRendered: false,
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
  selectionConfig: DomainSelectionConfig | undefined,
  cache: EnrichmentCache | undefined,
  ssrfChecker: SsrfChecker | undefined,
  logger: EnrichmentLogger,
  signal: CancellationSignal,
): Promise<{ records: SiteStructureRecord[]; fetchCount: number; networkErrors: number; cachedSuccesses: number; cachedErrors: number }> {
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
  const domainObservations: DomainObservation[] = [];
  for (const kw of selectedKeywords) {
    const rows = serpRowsByKeywordIdx.get(kw.keywordIdx) ?? [];
    for (const row of rows) {
      if (row.resultType !== 'organic' || !row.registrableDomain) continue;
      const existing = domainProvenance.get(row.registrableDomain);
      if (existing) {
        if (!existing.keywords.includes(kw.keyword)) existing.keywords.push(kw.keyword);
        if (row.position < existing.bestPosition) {
          existing.bestPosition = row.position;
        }
      } else {
        domainProvenance.set(row.registrableDomain, {
          keywords: [kw.keyword],
          bestPosition: row.position,
        });
      }
      domainObservations.push({
        keyword: kw.keyword,
        domain: row.registrableDomain,
        position: row.position,
        dr: row.dr,
        pageIdentity: clusteringUrlIdentity(row.url),
      });
    }
  }

  const selection = selectBoundedEvidenceDomains(
    sourceStore,
    sourceRunId,
    selectedKeywords.map((keyword) => keyword.keyword),
    domainObservations,
    siteStructureConfig.maxDomains,
    selectionConfig,
  );
  const domains = selection.selected;
  const omittedDomains = selection.omitted;
  const policy = selectionConfig?.algorithmVersion ?? 'legacy-fair';

  logger(`Inspecting site structure for ${domains.length} domains using ${policy} (${omittedDomains.length} omitted due to maxDomains=${siteStructureConfig.maxDomains})`);

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
    maxRetries: httpConfig.maxRetries,
    baseRetryDelayMs: httpConfig.baseRetryDelayMs,
  };
  if (ssrfChecker) fetcherCfg.ssrfChecker = ssrfChecker;

  const SITE_STRUCTURE_VERSION = '1.0.0';
  const siteStructureCacheIdentity = JSON.stringify({
    maxSitemapFiles: siteStructureConfig.maxSitemapFiles,
    maxUrlsPerSitemap: siteStructureConfig.maxUrlsPerSitemap,
    maxSampleUrls: siteStructureConfig.maxSampleUrls,
  });
  const records: SiteStructureRecord[] = [];
  let fetchCount = 0;
  let networkErrors = 0;
  let cachedSuccesses = 0;
  let cachedErrors = 0;

  for (const domain of domains) {
    if (signal.cancelled) break;

    const existing = existingTargets.get(domain);
    if (existing && existing.status === 'completed' && existing.data) {
      try {
        const parsed = JSON.parse(existing.data) as SiteStructureRecord;
        records.push({ ...parsed, cacheStatus: 'none' });
        continue;
      } catch {
      }
    }

    const provenance = domainProvenance.get(domain);
    const cacheKey = cache ? makeCacheKey(`site://${domain}`, SITE_STRUCTURE_VERSION, siteStructureCacheIdentity) : '';

    enrichmentStore.upsertSiteStructureTarget(enrichmentId, { domain, status: 'running' });

    let record: SiteStructureRecord | undefined;

    if (cache && cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached && cache.isFresh(cached)) {
        try {
          const parsed = JSON.parse(cached.data) as SiteStructureRecord;
          record = {
            ...parsed,
            cacheStatus: 'hit',
            sourceKeywords: provenance?.keywords ?? [],
            sourceBestPosition: provenance?.bestPosition ?? null,
          };
          if (record.homepageStatus === 'error' || record.homepageStatus === 'timeout') cachedErrors += 1;
          else cachedSuccesses += 1;
        } catch {
        }
      }
    }

    if (!record) {
      record = await inspectDomain(
        domain,
        fetcherCfg,
        siteStructureConfig,
        provenance?.keywords ?? [],
        provenance?.bestPosition ?? null,
      );
      fetchCount++;
      if (record.homepageStatus === 'error' || record.homepageStatus === 'timeout') networkErrors += 1;

      if (cache && cacheKey) {
        const status = record.robotsStatus === 'error' ? 'error' : 'ok';
        cache.set(cacheKey, `site://${domain}`, SITE_STRUCTURE_VERSION, JSON.stringify({ ...record, cacheStatus: 'none' }), status);
        record.cacheStatus = 'refreshed';
      }
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

  return { records, fetchCount, networkErrors, cachedSuccesses, cachedErrors };
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
  const robotsHttpStatus = robotsResult.status || null;
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
        rebuiltPages.push({
          url: t.url,
          finalUrl: t.url,
          redirectCount: 0,
          redirectChain: [],
          httpStatus: 0,
          contentType: null,
          fetchStatus: 'error',
          fetchError: 'corrupted checkpoint data',
          fetchedAt: t.fetchedAt ?? new Date().toISOString(),
          cacheStatus: 'none',
          title: null,
          metaDescription: null,
          h1: null,
          canonical: null,
          language: null,
          wordCount: null,
          possiblyJsRendered: false,
          forms: { formCount: 0, textareaCount: 0, inputCount: 0, fileInputCount: 0, buttonCount: 0 },
          structuredDataTypes: [],
          sourceKeywords: JSON.parse(t.sourceKeywords),
          sourcePositions: JSON.parse(t.sourcePositions),
        });
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
        possiblyJsRendered: false,
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
        rebuiltRecords.push({
          domain: t.domain,
          homepageStatus: 'error',
          homepageHttpStatus: null,
          robotsStatus: 'error',
          robotsHttpStatus: null,
          robotsUrl: null,
          sitemapUrlsFromRobots: [],
          sitemapFallbackUrl: null,
          sitemapType: 'none',
          declaredSitemapCount: 0,
          discoveredUrlCount: 0,
          sampledUrls: [],
          sampledUtilityUrls: [],
          errors: [{ url: `https://${t.domain}/`, error: 'corrupted checkpoint data' }],
          fetchedAt: t.fetchedAt ?? new Date().toISOString(),
          cacheStatus: 'none',
          sourceKeywords: [],
          sourceBestPosition: null,
        });
      }
    }
  }
  return rebuiltRecords;
}

function defaultClusteringConfig(): ClusteringConfig {
  return {
    topN: 10,
    edgeRule: {
      minSharedDomains: 3,
      minJaccard: 0.3,
      minSharedUrls: DEFAULT_CLUSTER_MIN_SHARED_URLS,
      minUrlJaccard: DEFAULT_CLUSTER_MIN_URL_JACCARD,
    },
    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
    urlIdentityVersion: CLUSTER_URL_IDENTITY_VERSION,
    groupingRule: 'complete_link',
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
