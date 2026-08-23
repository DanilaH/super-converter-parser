import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative as relativePath, resolve } from 'node:path';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { createRunDirectory, createRunId } from '../runs/run.js';
import { runEnrichment, type EnrichmentLogger, type CancellationSignal, type EnrichmentHttpConfig, type EnrichmentPagesConfig, type EnrichmentSiteStructureConfig } from '../enrichment/engine.js';
import { DEFAULT_CACHE_TTL, type CacheTtlConfig } from '../enrichment/cache.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig } from '../enrichment/clustering.js';
import {
  IMPLEMENTED_ENRICHMENT_MODULES,
  KNOWN_ENRICHMENT_MODULES,
  type EnrichmentModuleId,
} from '../enrichment/types.js';
import { ResearchError } from '../shared/errors.js';

function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) continue;
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore
  }
}

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
  sourceRunId: string;
  resumeEnrichmentId: string;
  modules: EnrichmentModuleId[];
  topN: number;
  minShared: number;
  minJaccard: number;
  shortlist: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let sourceRunId = '';
  let resumeEnrichmentId = '';
  let modules: EnrichmentModuleId[] = ['clusters'];
  let topN = 10;
  let minShared = 3;
  let minJaccard = 0.3;
  let shortlist: string[] = [];

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--run') {
      sourceRunId = args.shift() ?? '';
    } else if (arg === '--resume') {
      resumeEnrichmentId = args.shift() ?? '';
    } else if (arg === '--modules') {
      const value = args.shift();
      if (!value) throw new ResearchError('INPUT_SCHEMA_ERROR', '--modules requires a value');
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
      const value = args.shift();
      if (!value || Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--top-n requires a numeric value');
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `--top-n must be an integer, got ${value}`);
      }
      topN = parsed;
    } else if (arg === '--min-shared') {
      const value = args.shift();
      if (!value || Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--min-shared requires a numeric value');
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `--min-shared must be an integer, got ${value}`);
      }
      minShared = parsed;
    } else if (arg === '--min-jaccard') {
      const value = args.shift();
      if (!value || Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--min-jaccard requires a numeric value');
      }
      minJaccard = Number(value);
    } else if (arg === '--shortlist') {
      const value = args.shift();
      if (!value) throw new ResearchError('INPUT_SCHEMA_ERROR', '--shortlist requires a value');
      shortlist = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg && arg.startsWith('-')) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    }
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

  return { sourceRunId, resumeEnrichmentId, modules, topN, minShared, minJaccard, shortlist };
}

function findSourceRunDirectory(sourceRunId: string): string {
  const runsDir = resolve(process.cwd(), 'runs');
  const runDir = resolve(runsDir, sourceRunId);
  const relative = relativePath(runsDir, runDir);
  if (relative.startsWith('..') || isAbsolute(relative)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Invalid source run ID: ${sourceRunId}`);
  }
  const storePath = resolve(runDir, 'run.sqlite');
  if (!existsSync(storePath)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Source run not found: ${sourceRunId} (missing ${storePath})`);
  }
  return runDir;
}

function findEnrichmentDirectory(enrichmentId: string): string {
  const enrichmentsDir = resolve(process.cwd(), 'enrichments');
  const enrichmentDir = resolve(enrichmentsDir, enrichmentId);
  const relative = relativePath(enrichmentsDir, enrichmentDir);
  if (relative.startsWith('..') || isAbsolute(relative)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Invalid enrichment ID: ${enrichmentId}`);
  }
  return enrichmentDir;
}

function validateShortlist(sourceStorePath: string, sourceRunId: string, rawShortlist: string[]): string[] {
  if (rawShortlist.length === 0) return [];
  const sourceStore = RunStore.openReadOnly(sourceStorePath);
  try {
    const available = new Set(
      sourceStore.loadKeywords(sourceRunId).map((keyword) => keyword.normalizedKeyword),
    );
    const normalized = [...new Set(rawShortlist.map(normalizeKeyword))];
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

    if (!args.sourceRunId && !args.resumeEnrichmentId) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', '--run <source-run-id> or --resume <enrichment-id> is required');
    }
    if (args.sourceRunId && args.resumeEnrichmentId) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', '--run and --resume are mutually exclusive');
    }
    if (args.resumeEnrichmentId) {
      const forbiddenResumeFlags = ['--modules', '--top-n', '--min-shared', '--min-jaccard', '--shortlist'];
      const supplied = process.argv.slice(2).filter((arg) => forbiddenResumeFlags.includes(arg));
      if (supplied.length > 0) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `Resume reuses persisted config/shortlist; remove: ${supplied.join(', ')}`,
        );
      }
    }

    loadConfig(process.env);

    let enrichmentId: string;
    let enrichmentDirectory: string;
    let sourceRunId: string;
    let sourceStorePath: string;
    let clusteringConfig: ClusteringConfig;
    let shortlist: string[] = [];
    let modules: EnrichmentModuleId[];
    let isResume = false;
    let activeHttpConfig: EnrichmentHttpConfig = DEFAULT_HTTP_CONFIG;
    let activePagesConfig: EnrichmentPagesConfig = DEFAULT_PAGES_CONFIG;
    let activeSiteStructureConfig: EnrichmentSiteStructureConfig = DEFAULT_SITE_STRUCTURE_CONFIG;
    let activeCacheConfig = { dbPath: DEFAULT_CACHE_DB_PATH, ttl: DEFAULT_CACHE_TTL };

    if (args.resumeEnrichmentId) {
      isResume = true;
      enrichmentId = args.resumeEnrichmentId;
      enrichmentDirectory = findEnrichmentDirectory(enrichmentId);
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
      const sourceDir = findSourceRunDirectory(sourceRunId);
      sourceStorePath = resolve(sourceDir, 'run.sqlite');
      clusteringConfig = existingRun.config.clusters ?? {
        topN: 10,
        edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
        algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
      };
      shortlist = existingRun.shortlistKeywords;
      modules = existingRun.modules;
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
      const sourceDir = findSourceRunDirectory(sourceRunId);
      sourceStorePath = resolve(sourceDir, 'run.sqlite');
      enrichmentId = createRunId();
      enrichmentDirectory = findEnrichmentDirectory(enrichmentId);
      createRunDirectory(enrichmentDirectory);
      clusteringConfig = {
        topN: args.topN,
        edgeRule: {
          minSharedDomains: args.minShared,
          minJaccard: args.minJaccard,
        },
        algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
      };
      shortlist = validateShortlist(sourceStorePath, sourceRunId, args.shortlist);
      modules = args.modules;
    }

    store ??= RunStore.open(resolve(enrichmentDirectory, 'enrichment.sqlite'));

    console.log('Utility Research Runner — Enrichment');
    console.log('');
    const logger: EnrichmentLogger = (line: string) => console.log(line);

    const outcome = await runEnrichment({
      enrichmentId,
      sourceStoreOrPath: sourceStorePath,
      sourceRunId,
      enrichmentStore: store,
      enrichmentDirectory,
      modules,
      shortlist,
      config: { clusters: clusteringConfig },
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
    } else if (outcome.kind === 'completed' && outcome.result) {
      console.log('');
      if (outcome.result.clusters) {
        console.log(`Clusters: ${outcome.result.clusters.clusters.length}`);
      }
      if (outcome.result.pages) {
        console.log(`Pages: ${outcome.result.pages.length}`);
      }
      if (outcome.result.siteStructure) {
        console.log(`Domains: ${outcome.result.siteStructure.length}`);
      }
      console.log(`Artifacts: ${enrichmentDirectory}/`);
      if (outcome.result.clusters) {
        console.log('  keyword-clusters.csv');
        console.log('  keyword-clusters.json');
      }
      if (outcome.result.pages) {
        console.log('  pages.csv');
        console.log('  pages.json');
      }
      if (outcome.result.siteStructure) {
        console.log('  site-structure.csv');
        console.log('  site-structure.json');
      }
      console.log('  manifest.json');
      console.log('  status.json');
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
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
  }

  process.exit(exitCode);
}

main();
