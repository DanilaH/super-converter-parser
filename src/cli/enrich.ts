import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { loadDotEnv } from '../config/env.js';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { CacheStore } from '../cache/store.js';
import { createRunId } from '../runs/run.js';
import { runEnrichment, type EnrichmentHttpConfig, type EnrichmentPagesConfig, type EnrichmentSiteStructureConfig } from '../enrichment/engine.js';
import type { EnrichmentLogger, CancellationSignal } from '../enrichment/types.js';
import { DEFAULT_CACHE_TTL, type CacheTtlConfig } from '../enrichment/cache.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig } from '../enrichment/clustering.js';
import { createRdapClient } from '../rdap/client.js';
import { createFirstSeenClient } from '../firstseen/client.js';
import {
  buildDomainAgeConfigSnapshot,
  snapshotToFirstSeenClientConfig,
  snapshotToRdapClientConfig,
  type DomainAgeConfigSnapshot,
} from '../runs/domainAge.js';
import type { ResearchConfig } from '../config/config.js';
import {
  IMPLEMENTED_ENRICHMENT_MODULES,
  KNOWN_ENRICHMENT_MODULES,
  QUERY_SUGGESTION_SOURCES,
  QUERY_SUGGESTION_PARSER_VERSION,
  type EnrichmentModuleConfig,
  type EnrichmentModuleId,
  type QuerySuggestionSource,
} from '../enrichment/types.js';
import { ResearchError } from '../shared/errors.js';
import { allocateEnrichmentDirectory, archiveResearchDirectory, resolveEnrichmentLocation, resolveOutputRoot, resolveRunLocation, writeEnrichmentIndex } from '../outputs/researchLayout.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;
const EXIT_PAUSED = 130;

const DEFAULT_HTTP_CONFIG: EnrichmentHttpConfig = {
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

const DEFAULT_PAGES_CONFIG: EnrichmentPagesConfig = {
  enabled: true,
  topUrlsPerKeyword: 3,
  includeMainText: false,
  mainTextMaxChars: 5000,
};

const DEFAULT_SITE_STRUCTURE_CONFIG: EnrichmentSiteStructureConfig = {
  enabled: true,
  maxSitemapFiles: 10,
  maxUrlsPerSitemap: 100,
  maxSampleUrls: 50,
  maxDomains: 30,
};

const DEFAULT_CACHE_DB_PATH = 'data/cache/enrichment_http_cache.sqlite';

interface ParsedArgs {
  help: boolean;
  sourceRunId: string;
  resumeEnrichmentId: string;
  modules: EnrichmentModuleId[];
  topN: number;
  minShared: number;
  minJaccard: number;
  shortlist: string[];
  shortlistFile: string;
  sources: QuerySuggestionSource[];
  maxSuggestions: number;
  maxParents: number;
  outputRoot: string | null;
}

function nextOptionValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let help = false;
  let sourceRunId = '';
  let resumeEnrichmentId = '';
  let modules: EnrichmentModuleId[] = ['clusters'];
  let topN = 10;
  let minShared = 3;
  let minJaccard = 0.3;
  let shortlist: string[] = [];
  let shortlistFile = '';
  let sources: QuerySuggestionSource[] = [...QUERY_SUGGESTION_SOURCES];
  let maxSuggestions = 20;
  let maxParents = 200;
  let outputRoot: string | null = null;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--run') {
      sourceRunId = nextOptionValue(args, '--run');
    } else if (arg === '--resume') {
      resumeEnrichmentId = nextOptionValue(args, '--resume');
    } else if (arg === '--modules') {
      const value = nextOptionValue(args, '--modules');
      const parsed = value.split(',').map((m) => m.trim()).filter(Boolean);
      if (parsed.length === 0) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--modules must contain at least one module');
      }
      for (const m of parsed) {
        if (!KNOWN_ENRICHMENT_MODULES.includes(m as EnrichmentModuleId)) {
          throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown module: ${m}. Known: ${KNOWN_ENRICHMENT_MODULES.join(', ')}`);
        }
        if (!(IMPLEMENTED_ENRICHMENT_MODULES as readonly string[]).includes(m)) {
          throw new ResearchError('INPUT_SCHEMA_ERROR', `Module is reserved but not implemented yet: ${m}`);
        }
      }
      modules = parsed as EnrichmentModuleId[];
    } else if (arg === '--top-n') {
      const value = nextOptionValue(args, '--top-n');
      if (Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--top-n requires a numeric value');
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `--top-n must be an integer, got ${value}`);
      }
      topN = parsed;
    } else if (arg === '--min-shared') {
      const value = nextOptionValue(args, '--min-shared');
      if (Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--min-shared requires a numeric value');
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `--min-shared must be an integer, got ${value}`);
      }
      minShared = parsed;
    } else if (arg === '--min-jaccard') {
      const value = nextOptionValue(args, '--min-jaccard');
      if (Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--min-jaccard requires a numeric value');
      }
      minJaccard = Number(value);
    } else if (arg === '--shortlist') {
      const value = nextOptionValue(args, '--shortlist');
      shortlist = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--shortlist-file') {
      shortlistFile = nextOptionValue(args, '--shortlist-file');
    } else if (arg === '--sources') {
      const value = nextOptionValue(args, '--sources');
      const parsed = value.split(',').map((s) => s.trim()).filter(Boolean) as QuerySuggestionSource[];
      if (parsed.length === 0) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--sources must contain at least one source');
      }
      for (const s of parsed) {
        if (!QUERY_SUGGESTION_SOURCES.includes(s)) {
          throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown suggestion source: ${s}. Known: ${QUERY_SUGGESTION_SOURCES.join(', ')}`);
        }
      }
      sources = parsed;
    } else if (arg === '--max-suggestions-per-source') {
      const value = nextOptionValue(args, '--max-suggestions-per-source');
      if (Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--max-suggestions-per-source requires a numeric value');
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `--max-suggestions-per-source must be a positive integer, got ${value}`);
      }
      maxSuggestions = parsed;
    } else if (arg === '--output-root') {
      outputRoot = nextOptionValue(args, '--output-root');
    } else if (arg === '--max-parents') {
      const value = nextOptionValue(args, '--max-parents');
      if (Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--max-parents requires a numeric value');
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 5 || parsed > 200) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `--max-parents must be an integer in [5, 200], got ${value}`);
      }
      maxParents = parsed;
    } else if (arg && arg.startsWith('-')) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    }
  }

  if (help) {
    return { help, sourceRunId, resumeEnrichmentId, modules, topN, minShared, minJaccard, shortlist, shortlistFile, sources, maxSuggestions, maxParents, outputRoot };
  }

  if (topN <= 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `--top-n must be > 0, got ${topN}`);
  }
  if (minShared <= 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `--min-shared must be > 0, got ${minShared}`);
  }
  if (minShared > topN) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `--min-shared (${minShared}) cannot exceed --top-n (${topN})`);
  }
  if (minJaccard < 0 || minJaccard > 1) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `--min-jaccard must be in [0, 1], got ${minJaccard}`);
  }

  if (shortlist.length > 0 && shortlistFile) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--shortlist and --shortlist-file are mutually exclusive');
  }

  return { help, sourceRunId, resumeEnrichmentId, modules, topN, minShared, minJaccard, shortlist, shortlistFile, sources, maxSuggestions, maxParents, outputRoot };
}

function loadShortlistFile(path: string): string[] {
  let content: string;
  try {
    content = readFileSync(resolve(path), 'utf8');
  } catch (error) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Cannot read shortlist file "${path}".`, { cause: error });
  }
  if (content.trim() === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Shortlist file "${path}" is empty.`);
  }

  if (extname(path).toLowerCase() === '.csv') {
    let records: Array<Record<string, string>>;
    try {
      records = parse(content, { columns: true, skip_empty_lines: true, bom: true, trim: false }) as Array<Record<string, string>>;
    } catch (error) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Shortlist file "${path}" is not valid CSV.`, { cause: error });
    }
    const keywordColumn = Object.keys(records[0] ?? {}).find((column) => column.trim().toLowerCase() === 'keyword');
    if (!keywordColumn) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Shortlist CSV "${path}" must have a "keyword" column.`);
    }
    return records.map((record) => String(record[keywordColumn] ?? '').trim()).filter(Boolean);
  }

  return content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
}

function printUsage(): void {
  console.log('Utility Research Enrichment');
  console.log('');
  console.log('Usage:');
  console.log('  npm run enrich -- --run <run-id> --modules <modules> --shortlist-file <path>');
  console.log('  npm run enrich -- --resume <enrichment-id>');
  console.log('');
  console.log('Modules: clusters, query_suggestions, domain_age, pages, site_structure');
  console.log('Options:');
  console.log('  --shortlist <a,b,...>       Inline shortlist of 5-200 keywords.');
  console.log('  --shortlist-file <path>     TXT (one per line) or CSV with a keyword column.');
  console.log('  --sources <a,b,...>         Query-suggestion sources.');
  console.log('  --max-parents <5-200>       Query-suggestion parent cap (default 200).');
  console.log('  --output-root <path>        Durable output root.');
  console.log('  --help, -h                  Show this help.');
}

function buildEnrichmentConfig(
  modules: EnrichmentModuleId[],
  clusteringConfig: ClusteringConfig,
  sources: QuerySuggestionSource[],
  maxSuggestions: number,
  maxParents: number,
): EnrichmentModuleConfig {
  const config: EnrichmentModuleConfig = { clusters: clusteringConfig };
  if (modules.includes('query_suggestions')) {
    config.query_suggestions = {
      sources,
      maxSuggestionsPerSource: maxSuggestions,
      maxParents,
      rateLimitMinDelayMs: 1000,
      rateLimitMaxDelayMs: 10000,
      algorithmVersion: QUERY_SUGGESTION_PARSER_VERSION,
    };
  }
  return config;
}

function validateShortlist(sourceStorePath: string, sourceRunId: string, rawShortlist: string[]): string[] {
  if (rawShortlist.length === 0) return [];
  const sourceStore = RunStore.openReadOnly(sourceStorePath);
  try {
    const available = new Set(
      sourceStore.loadKeywords(sourceRunId).map((keyword) => keyword.normalizedKeyword),
    );
    const normalized = [...new Set(rawShortlist.map(normalizeKeyword))];
    if (normalized.length < 5 || normalized.length > 200) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `--shortlist must contain 5-200 unique keywords, got ${normalized.length}`,
      );
    }
    const rejected = normalized.filter((keyword) => !available.has(keyword));
    if (rejected.length > 0) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Shortlist keywords not found in source run: ${rejected.join(', ')}`,
      );
    }
    return normalized;
  } finally {
    sourceStore.close();
  }
}

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  let store: RunStore | undefined;
  let cacheStore: CacheStore | undefined;
  let enrichmentId: string | undefined;
  const signal: CancellationSignal = { cancelled: false };

  const sigintHandler = (): void => {
    if (signal.cancelled) {
      process.exit(EXIT_PAUSED);
    }
    (signal as { cancelled: boolean }).cancelled = true;
    console.log('');
    console.log('Stopping gracefully...');
  };
  const sigtermHandler = (): void => {
    (signal as { cancelled: boolean }).cancelled = true;
  };
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }

    if (!args.sourceRunId && !args.resumeEnrichmentId) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', '--run <source-run-id> or --resume <enrichment-id> is required');
    }
    if (args.sourceRunId && args.resumeEnrichmentId) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', '--run and --resume are mutually exclusive');
    }
    if (args.resumeEnrichmentId) {
      const forbiddenResumeFlags = ['--modules', '--top-n', '--min-shared', '--min-jaccard', '--shortlist', '--shortlist-file', '--sources', '--max-suggestions-per-source', '--max-parents'];
      const supplied = process.argv.slice(2).filter((arg) => forbiddenResumeFlags.includes(arg));
      if (supplied.length > 0) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `Resume reuses persisted config/shortlist; remove: ${supplied.join(', ')}`,
        );
      }
    }

    if (args.shortlistFile) {
      args.shortlist = loadShortlistFile(args.shortlistFile);
    }

    const config: ResearchConfig = loadConfig(process.env);
    const outputRoot = resolveOutputRoot(args.outputRoot, process.env);

    enrichmentId = '';
    let enrichmentDirectory: string;
    let researchDirectory: string;
    let archivePath: string;
    let sourceRunId: string;
    let sourceStorePath: string;
    let clusteringConfig: ClusteringConfig;
    let shortlist: string[] = [];
    let modules: EnrichmentModuleId[];
    let isResume = false;
    let domainAgeSnapshot: DomainAgeConfigSnapshot | undefined;
    let activeHttpConfig: EnrichmentHttpConfig = DEFAULT_HTTP_CONFIG;
    let activePagesConfig: EnrichmentPagesConfig = DEFAULT_PAGES_CONFIG;
    let activeSiteStructureConfig: EnrichmentSiteStructureConfig = DEFAULT_SITE_STRUCTURE_CONFIG;
    let activeCacheConfig = { dbPath: DEFAULT_CACHE_DB_PATH, ttl: DEFAULT_CACHE_TTL };

    if (args.resumeEnrichmentId) {
      isResume = true;
      enrichmentId = args.resumeEnrichmentId;
      const enrichmentLocation = await resolveEnrichmentLocation(outputRoot, enrichmentId);
      enrichmentDirectory = enrichmentLocation.enrichmentDirectory;
      researchDirectory = enrichmentLocation.researchDirectory;
      archivePath = enrichmentLocation.archivePath;
      const existingStorePath = resolve(enrichmentDirectory, 'enrichment.sqlite');
      if (!existsSync(existingStorePath)) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${enrichmentId}`);
      }
      store = RunStore.open(existingStorePath);
      const existingRun = store.loadEnrichmentRun(enrichmentId);
      if (!existingRun) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${enrichmentId}`);
      }
      if (existingRun.state === 'completed') {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment already completed: ${enrichmentId}`);
      }
      sourceRunId = existingRun.sourceRunId;
      const sourceLocation = await resolveRunLocation(outputRoot, sourceRunId);
      sourceStorePath = resolve(sourceLocation.discoveryDirectory, 'run.sqlite');
      clusteringConfig = existingRun.config.clusters ?? {
        topN: 10,
        edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
        algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
      };
      shortlist = existingRun.shortlistKeywords;
      if (existingRun.modules.includes('query_suggestions') && (shortlist.length < 5 || shortlist.length > 200)) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `Persisted shortlist has ${shortlist.length} keywords; required 5-200. Cannot resume.`,
        );
      }
      modules = existingRun.modules;
      // Restore the domain_age config snapshot so resume reproduces the original
      // provider/endpoints/TTL semantics instead of the current environment.
      domainAgeSnapshot = existingRun.config.domain_age as DomainAgeConfigSnapshot | undefined;
      activeHttpConfig = existingRun.config.http
        ? { ...DEFAULT_HTTP_CONFIG, ...existingRun.config.http } as EnrichmentHttpConfig
        : DEFAULT_HTTP_CONFIG;
      activePagesConfig = existingRun.config.pages
        ? { ...DEFAULT_PAGES_CONFIG, ...existingRun.config.pages } as EnrichmentPagesConfig
        : DEFAULT_PAGES_CONFIG;
      activeSiteStructureConfig = existingRun.config.site_structure
        ? { ...DEFAULT_SITE_STRUCTURE_CONFIG, ...existingRun.config.site_structure } as EnrichmentSiteStructureConfig
        : DEFAULT_SITE_STRUCTURE_CONFIG;
      activeCacheConfig = existingRun.config.cache
        ? {
            dbPath: ((existingRun.config.cache as Record<string, unknown>).dbPath as string) ?? DEFAULT_CACHE_DB_PATH,
            ttl: ((existingRun.config.cache as Record<string, unknown>).ttl as CacheTtlConfig) ?? DEFAULT_CACHE_TTL,
          }
        : { dbPath: DEFAULT_CACHE_DB_PATH, ttl: DEFAULT_CACHE_TTL };
    } else {
      sourceRunId = args.sourceRunId;
      const sourceLocation = await resolveRunLocation(outputRoot, sourceRunId);
      sourceStorePath = resolve(sourceLocation.discoveryDirectory, 'run.sqlite');
      researchDirectory = sourceLocation.researchDirectory;
      archivePath = sourceLocation.archivePath;
      enrichmentId = createRunId();
      enrichmentDirectory = await allocateEnrichmentDirectory(researchDirectory);
      await writeEnrichmentIndex(outputRoot, {
        version: 1,
        enrichmentId,
        runId: sourceRunId,
        researchDirectory,
        enrichmentDirectory,
      });
      clusteringConfig = {
        topN: args.topN,
        edgeRule: {
          minSharedDomains: args.minShared,
          minJaccard: args.minJaccard,
        },
        algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
      };
      modules = args.modules;
      shortlist = modules.includes('query_suggestions') || modules.includes('domain_age')
        ? validateShortlist(sourceStorePath, sourceRunId, args.shortlist)
        : (args.shortlist && args.shortlist.length > 0 ? validateShortlist(sourceStorePath, sourceRunId, args.shortlist) : []);
      if (modules.includes('domain_age')) {
        domainAgeSnapshot = buildDomainAgeConfigSnapshot(config);
      }
    }

    store ??= RunStore.open(resolve(enrichmentDirectory, 'enrichment.sqlite'));

    const needsDomainAge = modules.includes('domain_age');
    if (needsDomainAge && !domainAgeSnapshot) {
      throw new ResearchError(
        'RESUME_CONFIG_MISMATCH',
        'The "domain_age" module requires a domain_age config snapshot; it was not found on the stored run.',
      );
    }
    if (needsDomainAge) {
      cacheStore = CacheStore.open(resolve(config.cache.path));
    }
    const rdapClient = needsDomainAge && domainAgeSnapshot
      ? createRdapClient(snapshotToRdapClientConfig(domainAgeSnapshot, { random: Math.random }))
      : null;
    const firstSeenClient = needsDomainAge && domainAgeSnapshot
      ? createFirstSeenClient(snapshotToFirstSeenClientConfig(domainAgeSnapshot, {}))
      : null;

    console.log('Utility Research Runner — Enrichment');
    console.log('');
    console.log(`Research directory: ${researchDirectory}`);
    console.log(`Enrichment directory: ${enrichmentDirectory}`);
    const logger: EnrichmentLogger = (line: string) => console.log(line);

    let enrichmentConfig: EnrichmentModuleConfig;
    if (isResume) {
      const persistedRun = store.loadEnrichmentRun(enrichmentId);
      if (!persistedRun) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${enrichmentId}`);
      }
      enrichmentConfig = persistedRun.config;
      if (!enrichmentConfig.clusters) {
        enrichmentConfig.clusters = clusteringConfig;
      }
    } else {
      enrichmentConfig = buildEnrichmentConfig(modules, clusteringConfig, args.sources, args.maxSuggestions, args.maxParents);
    }

    const outcome = await runEnrichment({
      enrichmentId,
      sourceStoreOrPath: sourceStorePath,
      sourceRunId,
      enrichmentStore: store,
      enrichmentDirectory,
      modules,
      shortlist,
      config: {
        ...enrichmentConfig,
        ...(domainAgeSnapshot ? { domain_age: domainAgeSnapshot } : {}),
      },
      ...(domainAgeSnapshot ? { domainAgeConfig: domainAgeSnapshot } : {}),
      ...(cacheStore ? { cacheStore } : {}),
      ...(rdapClient ? { rdapClient } : {}),
      ...(firstSeenClient ? { firstSeenClient } : {}),
      httpConfig: activeHttpConfig,
      pagesConfig: activePagesConfig,
      siteStructureConfig: activeSiteStructureConfig,
      cacheConfig: activeCacheConfig,
      logger,
      signal,
      resume: isResume,
    });

    if (outcome.kind === 'paused') {
      console.log('Run paused. Resume with:');
      console.log(`  npm run enrich -- --resume ${enrichmentId}`);
      exitCode = EXIT_PAUSED;
    } else if (outcome.kind === 'completed') {
      console.log('');
      console.log(`Artifacts: ${enrichmentDirectory}/`);
      if (outcome.domainAgeRecords) {
        console.log(`Domains enriched: ${outcome.domainAgeRecords.size}`);
      }
      if (outcome.result?.clusters) {
        console.log(`Clusters: ${outcome.result.clusters.clusters.length}`);
      }
      if (outcome.result?.pages) {
        console.log(`Pages: ${outcome.result.pages.length}`);
      }
      if (outcome.result?.siteStructure) {
        console.log(`Site structure domains: ${outcome.result.siteStructure.length}`);
      }
      if (outcome.result?.clusters) {
        console.log('  keyword-clusters.csv');
        console.log('  keyword-clusters.json');
      }
      if (outcome.domainAgeRecords) {
        console.log('  domain-age.csv');
        console.log('  domain-age.json');
      }
      if (outcome.result?.pages) {
        console.log('  pages.csv');
        console.log('  pages.json');
      }
      if (outcome.result?.siteStructure) {
        console.log('  site-structure.csv');
        console.log('  site-structure.json');
      }
      if (modules.includes('query_suggestions')) {
        console.log('  query-suggestions.csv');
        console.log('  query-suggestions.json');
      }
      console.log('  manifest.json');
      console.log('  status.json');
      store.close();
      store = undefined;
      cacheStore?.close();
      cacheStore = undefined;
      try {
        archivePath = await archiveResearchDirectory(researchDirectory);
        console.log(`Archive: ${archivePath}`);
      } catch (archiveError) {
        const message = archiveError instanceof Error ? archiveError.message : String(archiveError);
        console.error(`Archive warning: ${message}`);
      }
    } else if (outcome.kind === 'failed') {
      console.error(`Enrichment failed: ${outcome.error}`);
      exitCode = EXIT_INTERNAL;
    }
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`Error: ${error.message}`);
      if (error.code === 'INPUT_SCHEMA_ERROR') {
        exitCode = EXIT_INVALID_INPUT;
      } else {
        exitCode = EXIT_INTERNAL;
      }
    } else {
      console.error('Unexpected error:', error);
      exitCode = EXIT_INTERNAL;
    }
  } finally {
    store?.close();
    cacheStore?.close();
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
  }

  process.exit(exitCode);
}

main();
