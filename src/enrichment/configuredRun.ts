import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { createFirstSeenClient } from '../firstseen/client.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import {
  allocateEnrichmentDirectory,
  archiveResearchDirectory,
  resolveEnrichmentLocation,
  resolveRunLocation,
  writeEnrichmentIndex,
} from '../outputs/researchLayout.js';
import type { PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import { canonicalJson } from '../operatorConfig/resolve.js';
import { createRdapClient } from '../rdap/client.js';
import { createRunId } from '../runs/run.js';
import {
  buildDomainAgeConfigSnapshot,
  snapshotToFirstSeenClientConfig,
  snapshotToRdapClientConfig,
  type DomainAgeConfigSnapshot,
} from '../runs/domainAge.js';
import { ResearchError } from '../shared/errors.js';
import {
  CLUSTERING_ALGORITHM_VERSION,
  type ClusteringConfig,
} from './clustering.js';
import { DEFAULT_CACHE_TTL, type CacheTtlConfig } from './cache.js';
import {
  runEnrichment,
  type EnrichmentHttpConfig,
  type EnrichmentOutcome,
  type EnrichmentPagesConfig,
  type EnrichmentSiteStructureConfig,
} from './engine.js';
import {
  IMPLEMENTED_ENRICHMENT_MODULES,
  QUERY_SUGGESTION_PARSER_VERSION,
  type CancellationSignal,
  type EnrichmentLogger,
  type EnrichmentModuleConfig,
  type EnrichmentModuleId,
} from './types.js';
import { CLUSTER_URL_IDENTITY_VERSION } from './urlIdentity.js';

export const CONFIGURED_ENRICHMENT_HTTP_DEFAULTS: EnrichmentHttpConfig = {
  enabled: true,
  maxRedirects: 5,
  timeoutMs: 15_000,
  maxBytes: 2_000_000,
  maxTextBytes: 500_000,
  userAgent: 'UtilityResearchRunner/1.0 (+https://local.dev)',
  respectRetryAfter: true,
  minDelayMs: 500,
  maxDelayMs: 2000,
  maxRetries: 2,
  baseRetryDelayMs: 1000,
};

export const CONFIGURED_ENRICHMENT_PAGES_DEFAULTS: EnrichmentPagesConfig = {
  enabled: true,
  topUrlsPerKeyword: 3,
  includeMainText: false,
  mainTextMaxChars: 5000,
};

export const CONFIGURED_ENRICHMENT_SITE_STRUCTURE_DEFAULTS: EnrichmentSiteStructureConfig = {
  enabled: true,
  maxSitemapFiles: 10,
  maxUrlsPerSitemap: 100,
  maxSampleUrls: 50,
  maxDomains: 30,
};

export const CONFIGURED_ENRICHMENT_HTTP_CACHE_PATH = 'data/cache/enrichment_http_cache.sqlite';

const SHORTLIST_REQUIRED_MODULES = new Set<EnrichmentModuleId>([
  'query_suggestions',
  'domain_age',
  'pages',
  'site_structure',
]);

export type ConfiguredEnrichmentRequest = {
  outputRoot: string;
  researchId: string;
  researchDirectory: string;
  sourceRunId: string;
  currentEnrichmentId: string | null;
  operatorConfig: PersistedOperatorConfigV1;
  shortlistPath: string | null;
  env?: NodeJS.ProcessEnv;
  signal: CancellationSignal;
  logger?: EnrichmentLogger;
};

export type ConfiguredEnrichmentResult = {
  outcome: EnrichmentOutcome;
  enrichmentId: string;
  enrichmentDirectory: string;
  resumed: boolean;
  archivePath: string | null;
};

export async function runConfiguredEnrichment(
  request: ConfiguredEnrichmentRequest,
): Promise<ConfiguredEnrichmentResult> {
  const semantics = request.operatorConfig.semantics;
  if (semantics.enrichment === null) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Persisted OperatorConfig does not request enrichment.');
  }
  if (semantics.workflow.target === 'discovery') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Persisted OperatorConfig workflow target is discovery; enrichment is not requested.');
  }

  const modules = configuredModules(semantics.enrichment.modules);
  const sourceLocation = await resolveRunLocation(request.outputRoot, request.sourceRunId);
  if (resolve(sourceLocation.researchDirectory) !== resolve(request.researchDirectory)) {
    throw new ResearchError(
      'RESUME_CONFIG_MISMATCH',
      `Discovery ${request.sourceRunId} belongs to a different research directory than stable research ${request.researchId}.`,
    );
  }
  const sourceStorePath = join(sourceLocation.discoveryDirectory, 'run.sqlite');
  const runtimeConfig = loadConfig(request.env ?? process.env);
  const logger = request.logger ?? ((line: string) => console.log(line));

  let enrichmentId: string;
  let enrichmentDirectory: string;
  let enrichmentStore: RunStore | undefined;
  let cacheStore: CacheStore | undefined;
  let shortlist: string[];
  let enrichmentConfig: EnrichmentModuleConfig;
  let domainAgeSnapshot: DomainAgeConfigSnapshot | undefined;
  let activeHttpConfig: EnrichmentHttpConfig = CONFIGURED_ENRICHMENT_HTTP_DEFAULTS;
  let activePagesConfig: EnrichmentPagesConfig = CONFIGURED_ENRICHMENT_PAGES_DEFAULTS;
  let activeSiteStructureConfig: EnrichmentSiteStructureConfig = CONFIGURED_ENRICHMENT_SITE_STRUCTURE_DEFAULTS;
  let activeCacheConfig = { dbPath: CONFIGURED_ENRICHMENT_HTTP_CACHE_PATH, ttl: DEFAULT_CACHE_TTL };
  let freshAllocation: { enrichmentId: string; enrichmentDirectory: string } | null = null;
  const resumed = request.currentEnrichmentId !== null;

  try {
    if (resumed) {
      enrichmentId = request.currentEnrichmentId as string;
      const location = await resolveEnrichmentLocation(request.outputRoot, enrichmentId);
      if (resolve(location.researchDirectory) !== resolve(request.researchDirectory)) {
        throw new ResearchError('RESUME_CONFIG_MISMATCH', `Enrichment ${enrichmentId} does not belong to research ${request.researchId}.`);
      }
      enrichmentDirectory = location.enrichmentDirectory;
      enrichmentStore = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
      const existing = enrichmentStore.loadEnrichmentRun(enrichmentId);
      if (!existing) throw new ResearchError('RESUME_NOT_FOUND', `Enrichment not found: ${enrichmentId}.`);
      if (existing.state === 'completed') {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment already completed: ${enrichmentId}.`);
      }
      if (existing.sourceRunId !== request.sourceRunId) {
        throw new ResearchError(
          'RESUME_CONFIG_MISMATCH',
          `Enrichment ${enrichmentId} is pinned to discovery ${existing.sourceRunId}, not current discovery ${request.sourceRunId}.`,
        );
      }
      assertConfiguredResumeCompatible(existing.modules, existing.config, modules, request.operatorConfig);
      shortlist = existing.shortlistKeywords;
      if (request.shortlistPath !== null) {
        const supplied = await loadAndValidateShortlist(request.shortlistPath, sourceStorePath, request.sourceRunId);
        if (canonicalJson(supplied) !== canonicalJson(shortlist)) {
          throw new ResearchError(
            'RESUME_CONFIG_MISMATCH',
            `Continuation shortlist differs from the shortlist persisted by enrichment ${enrichmentId}; resume cannot change evidence scope.`,
          );
        }
      }
      assertShortlistRequirement(modules, shortlist, 'Persisted shortlist');
      enrichmentConfig = existing.config;
      domainAgeSnapshot = existing.config.domain_age as DomainAgeConfigSnapshot | undefined;
      activeHttpConfig = existing.config.http
        ? { ...CONFIGURED_ENRICHMENT_HTTP_DEFAULTS, ...existing.config.http } as EnrichmentHttpConfig
        : CONFIGURED_ENRICHMENT_HTTP_DEFAULTS;
      activePagesConfig = existing.config.pages
        ? { ...CONFIGURED_ENRICHMENT_PAGES_DEFAULTS, ...existing.config.pages } as EnrichmentPagesConfig
        : CONFIGURED_ENRICHMENT_PAGES_DEFAULTS;
      activeSiteStructureConfig = existing.config.site_structure
        ? { ...CONFIGURED_ENRICHMENT_SITE_STRUCTURE_DEFAULTS, ...existing.config.site_structure } as EnrichmentSiteStructureConfig
        : CONFIGURED_ENRICHMENT_SITE_STRUCTURE_DEFAULTS;
      activeCacheConfig = existing.config.cache
        ? {
            dbPath: ((existing.config.cache as Record<string, unknown>).dbPath as string) ?? CONFIGURED_ENRICHMENT_HTTP_CACHE_PATH,
            ttl: ((existing.config.cache as Record<string, unknown>).ttl as CacheTtlConfig) ?? DEFAULT_CACHE_TTL,
          }
        : { dbPath: CONFIGURED_ENRICHMENT_HTTP_CACHE_PATH, ttl: DEFAULT_CACHE_TTL };
    } else {
      shortlist = request.shortlistPath === null
        ? []
        : await loadAndValidateShortlist(request.shortlistPath, sourceStorePath, request.sourceRunId);
      assertShortlistRequirement(modules, shortlist, 'Shortlist');
      enrichmentId = createRunId();
      enrichmentDirectory = await allocateEnrichmentDirectory(request.researchDirectory);
      await writeEnrichmentIndex(request.outputRoot, {
        version: 1,
        enrichmentId,
        runId: request.sourceRunId,
        researchDirectory: request.researchDirectory,
        enrichmentDirectory,
      });
      freshAllocation = { enrichmentId, enrichmentDirectory };
      enrichmentStore = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
      enrichmentConfig = buildConfiguredModuleConfig(request.operatorConfig);
      if (modules.includes('domain_age')) {
        domainAgeSnapshot = buildDomainAgeConfigSnapshot(runtimeConfig);
        enrichmentConfig = { ...enrichmentConfig, domain_age: domainAgeSnapshot };
      }
    }

    const needsDomainAge = modules.includes('domain_age');
    if (needsDomainAge && !domainAgeSnapshot) {
      throw new ResearchError(
        'RESUME_CONFIG_MISMATCH',
        `Enrichment ${enrichmentId} requires a persisted domain_age config snapshot.`,
      );
    }
    if (needsDomainAge) cacheStore = CacheStore.open(resolve(runtimeConfig.cache.path));
    const rdapClient = needsDomainAge && domainAgeSnapshot
      ? createRdapClient(snapshotToRdapClientConfig(domainAgeSnapshot, { random: Math.random }))
      : null;
    const firstSeenClient = needsDomainAge && domainAgeSnapshot
      ? createFirstSeenClient(snapshotToFirstSeenClientConfig(domainAgeSnapshot, {}))
      : null;

    const needsHttpCache = modules.includes('pages') || modules.includes('site_structure');
    if (needsHttpCache) {
      await mkdir(dirname(resolve(activeCacheConfig.dbPath)), { recursive: true });
    }

    const outcome = await runEnrichment({
      enrichmentId,
      sourceStoreOrPath: sourceStorePath,
      sourceRunId: request.sourceRunId,
      enrichmentStore,
      enrichmentDirectory,
      modules,
      shortlist,
      config: enrichmentConfig,
      ...(domainAgeSnapshot ? { domainAgeConfig: domainAgeSnapshot } : {}),
      ...(cacheStore ? { cacheStore } : {}),
      ...(rdapClient ? { rdapClient } : {}),
      ...(firstSeenClient ? { firstSeenClient } : {}),
      httpConfig: activeHttpConfig,
      pagesConfig: activePagesConfig,
      siteStructureConfig: activeSiteStructureConfig,
      ...(needsHttpCache ? { cacheConfig: activeCacheConfig } : {}),
      logger,
      signal: request.signal,
      resume: resumed,
    });

    if (!resumed && enrichmentStore.loadEnrichmentRun(enrichmentId) === null) {
      const startupMessage = outcome.kind === 'failed'
        ? outcome.error
        : `engine returned ${outcome.kind} without creating its durable enrichment run row`;
      enrichmentStore.close();
      enrichmentStore = undefined;
      cacheStore?.close();
      cacheStore = undefined;
      await rollbackUndurableFreshEnrichment(request.outputRoot, enrichmentId, enrichmentDirectory);
      freshAllocation = null;
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Configured enrichment ${enrichmentId} failed before durable run initialization: ${startupMessage}`,
      );
    }

    let archivePath: string | null = null;
    if (outcome.kind === 'completed') {
      enrichmentStore.close();
      enrichmentStore = undefined;
      cacheStore?.close();
      cacheStore = undefined;
      try {
        archivePath = await archiveResearchDirectory(request.researchDirectory);
      } catch (error) {
        logger(`Archive warning: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { outcome, enrichmentId, enrichmentDirectory, resumed, archivePath };
  } catch (error) {
    if (!resumed && freshAllocation !== null) {
      const durableState = enrichmentStore === undefined
        ? false
        : inspectDurableRun(enrichmentStore, freshAllocation.enrichmentId);
      if (durableState === false) {
        enrichmentStore?.close();
        enrichmentStore = undefined;
        cacheStore?.close();
        cacheStore = undefined;
        await rollbackUndurableFreshEnrichment(
          request.outputRoot,
          freshAllocation.enrichmentId,
          freshAllocation.enrichmentDirectory,
        );
        freshAllocation = null;
      }
    }
    throw error;
  } finally {
    enrichmentStore?.close();
    cacheStore?.close();
  }
}

export function buildConfiguredModuleConfig(operatorConfig: PersistedOperatorConfigV1): EnrichmentModuleConfig {
  const semantics = operatorConfig.semantics.enrichment;
  if (semantics === null) throw new ResearchError('INPUT_SCHEMA_ERROR', 'OperatorConfig enrichment semantics are missing.');
  const clustering: ClusteringConfig = {
    topN: semantics.clustering.topN,
    edgeRule: {
      minSharedDomains: semantics.clustering.minSharedDomains,
      minJaccard: semantics.clustering.minDomainJaccard,
      minSharedUrls: semantics.clustering.minSharedUrls,
      minUrlJaccard: semantics.clustering.minUrlJaccard,
    },
    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
    urlIdentityVersion: CLUSTER_URL_IDENTITY_VERSION,
    groupingRule: 'complete_link',
  };
  const config: EnrichmentModuleConfig = { clusters: clustering };
  if (semantics.modules.includes('query_suggestions')) {
    if (semantics.querySuggestions === null) {
      throw new ResearchError('OUTPUT_WRITE_ERROR', 'Persisted OperatorConfig requests query_suggestions without resolved query-suggestion semantics.');
    }
    config.query_suggestions = {
      sources: [...semantics.querySuggestions.sources],
      maxSuggestionsPerSource: semantics.querySuggestions.maxSuggestionsPerSource,
      maxParents: semantics.querySuggestions.maxParents,
      rateLimitMinDelayMs: 1000,
      rateLimitMaxDelayMs: 10_000,
      algorithmVersion: QUERY_SUGGESTION_PARSER_VERSION,
    };
  }
  return config;
}

export async function loadAndValidateShortlist(
  path: string,
  sourceStorePath: string,
  sourceRunId: string,
): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(resolve(path), 'utf8');
  } catch (error) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Cannot read shortlist file "${path}".`, { cause: error });
  }
  if (content.trim() === '') throw new ResearchError('INPUT_SCHEMA_ERROR', `Shortlist file "${path}" is empty.`);

  let values: string[];
  if (extname(path).toLowerCase() === '.csv') {
    let records: Array<Record<string, string>>;
    try {
      records = parse(content, { columns: true, skip_empty_lines: true, bom: true, trim: false }) as Array<Record<string, string>>;
    } catch (error) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Shortlist file "${path}" is not valid CSV.`, { cause: error });
    }
    const keywordColumn = Object.keys(records[0] ?? {}).find((column) => column.trim().toLowerCase() === 'keyword');
    if (!keywordColumn) throw new ResearchError('INPUT_SCHEMA_ERROR', `Shortlist CSV "${path}" must have a "keyword" column.`);
    values = records.map((record) => String(record[keywordColumn] ?? '').trim()).filter(Boolean);
  } else {
    values = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
  }

  const normalized = [...new Set(values.map(normalizeKeyword))];
  if (normalized.length < 5 || normalized.length > 200) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Shortlist must contain 5-200 unique keywords, got ${normalized.length}.`);
  }

  const sourceStore = RunStore.openReadOnly(sourceStorePath);
  try {
    const available = new Set(sourceStore.loadKeywords(sourceRunId).map((keyword) => keyword.normalizedKeyword));
    const rejected = normalized.filter((keyword) => !available.has(keyword));
    if (rejected.length > 0) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Shortlist keywords not found in current discovery: ${rejected.join(', ')}.`);
    }
  } finally {
    sourceStore.close();
  }
  return normalized;
}

function configuredModules(raw: string[]): EnrichmentModuleId[] {
  for (const module of raw) {
    if (!(IMPLEMENTED_ENRICHMENT_MODULES as readonly string[]).includes(module)) {
      throw new ResearchError('OUTPUT_WRITE_ERROR', `Persisted OperatorConfig contains unsupported enrichment module "${module}".`);
    }
  }
  return [...raw] as EnrichmentModuleId[];
}

function assertShortlistRequirement(modules: EnrichmentModuleId[], shortlist: string[], label: string): void {
  const requiredBy = modules.filter((module) => SHORTLIST_REQUIRED_MODULES.has(module));
  if (requiredBy.length === 0) return;
  if (shortlist.length < 5 || shortlist.length > 200) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `${label} has ${shortlist.length} keywords; modules ${requiredBy.join(', ')} require 5-200.`,
    );
  }
}

function assertConfiguredResumeCompatible(
  persistedModules: EnrichmentModuleId[],
  persistedConfig: EnrichmentModuleConfig,
  configuredModulesValue: EnrichmentModuleId[],
  operatorConfig: PersistedOperatorConfigV1,
): void {
  const persistedSorted = [...persistedModules].sort();
  const configuredSorted = [...configuredModulesValue].sort();
  if (canonicalJson(persistedSorted) !== canonicalJson(configuredSorted)) {
    throw new ResearchError(
      'RESUME_CONFIG_MISMATCH',
      `Persisted enrichment modules ${persistedSorted.join(', ')} differ from OperatorConfig modules ${configuredSorted.join(', ')}.`,
    );
  }
  const expected = buildConfiguredModuleConfig(operatorConfig);
  if (canonicalJson(persistedConfig.clusters ?? null) !== canonicalJson(expected.clusters ?? null)) {
    throw new ResearchError('RESUME_CONFIG_MISMATCH', 'Persisted clustering config differs from OperatorConfig enrichment semantics.');
  }
  if (configuredSorted.includes('query_suggestions')) {
    if (canonicalJson(persistedConfig.query_suggestions ?? null) !== canonicalJson(expected.query_suggestions ?? null)) {
      throw new ResearchError('RESUME_CONFIG_MISMATCH', 'Persisted query-suggestion config differs from OperatorConfig enrichment semantics.');
    }
  }
}

function inspectDurableRun(store: RunStore, enrichmentId: string): boolean | null {
  try {
    return store.loadEnrichmentRun(enrichmentId) !== null;
  } catch {
    return null;
  }
}

async function rollbackUndurableFreshEnrichment(
  outputRoot: string,
  enrichmentId: string,
  enrichmentDirectory: string,
): Promise<void> {
  try {
    await rm(enrichmentDirectory, { recursive: true, force: true });
    await rm(join(outputRoot, 'index', 'enrichments', `${enrichmentId}.json`), { force: true });
  } catch (error) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to roll back undurable enrichment allocation ${enrichmentId}.`,
      { cause: error },
    );
  }
}
