import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative as relativePath, resolve } from 'node:path';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { createRunDirectory, createRunId } from '../runs/run.js';
import { runEnrichment } from '../enrichment/engine.js';
import type { EnrichmentLogger, CancellationSignal } from '../enrichment/types.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig } from '../enrichment/clustering.js';
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

interface ParsedArgs {
  sourceRunId: string;
  resumeEnrichmentId: string;
  modules: EnrichmentModuleId[];
  topN: number;
  minShared: number;
  minJaccard: number;
  shortlist: string[];
  sources: QuerySuggestionSource[];
  maxSuggestions: number;
  maxParents: number;
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
  let sources: QuerySuggestionSource[] = [...QUERY_SUGGESTION_SOURCES];
  let maxSuggestions = 20;
  let maxParents = 30;

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
    } else if (arg === '--sources') {
      const value = args.shift();
      if (!value) throw new ResearchError('INPUT_SCHEMA_ERROR', '--sources requires a value');
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
      const value = args.shift();
      if (!value || Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--max-suggestions-per-source requires a numeric value');
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `--max-suggestions-per-source must be a positive integer, got ${value}`);
      }
      maxSuggestions = parsed;
    } else if (arg === '--max-parents') {
      const value = args.shift();
      if (!value || Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--max-parents requires a numeric value');
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 5 || parsed > 30) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `--max-parents must be an integer in [5, 30], got ${value}`);
      }
      maxParents = parsed;
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

  return { sourceRunId, resumeEnrichmentId, modules, topN, minShared, minJaccard, shortlist, sources, maxSuggestions, maxParents };
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
  if (rawShortlist.length === 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'query_suggestions requires --shortlist with 5-30 parent keywords. Full-source-run mode is not supported.',
    );
  }
  const sourceStore = RunStore.openReadOnly(sourceStorePath);
  try {
    const available = new Set(
      sourceStore.loadKeywords(sourceRunId).map((keyword) => keyword.normalizedKeyword),
    );
    const normalized = [...new Set(rawShortlist.map(normalizeKeyword))];
    if (normalized.length < 5 || normalized.length > 30) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `--shortlist must contain 5-30 unique keywords, got ${normalized.length}`,
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
      const forbiddenResumeFlags = ['--modules', '--top-n', '--min-shared', '--min-jaccard', '--shortlist', '--sources', '--max-suggestions-per-source', '--max-parents'];
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
      if (shortlist.length < 5 || shortlist.length > 30) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `Persisted shortlist has ${shortlist.length} keywords; required 5-30. Cannot resume.`,
        );
      }
      modules = existingRun.modules;
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
      config: enrichmentConfig,
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
      if (outcome.result) {
        console.log(`Clusters: ${outcome.result.clusters.length}`);
        console.log('  keyword-clusters.csv');
        console.log('  keyword-clusters.json');
      }
      if (modules.includes('query_suggestions')) {
        console.log('  query-suggestions.csv');
        console.log('  query-suggestions.json');
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
