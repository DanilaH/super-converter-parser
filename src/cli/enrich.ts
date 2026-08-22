import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { createRunDirectory, createRunId } from '../runs/run.js';
import { runEnrichment, NEVER_CANCELLED, type EnrichmentLogger, type CancellationSignal } from '../enrichment/engine.js';
import { writeKeywordClustersCsv, writeKeywordClustersJson } from '../enrichment/outputs.js';
import { CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig } from '../enrichment/clustering.js';
import { KNOWN_ENRICHMENT_MODULES, type EnrichmentModuleId } from '../enrichment/types.js';
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
      for (const m of parsed) {
        if (!KNOWN_ENRICHMENT_MODULES.includes(m as EnrichmentModuleId)) {
          throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown module: ${m}. Known: ${KNOWN_ENRICHMENT_MODULES.join(', ')}`);
        }
      }
      modules = parsed as EnrichmentModuleId[];
    } else if (arg === '--top-n') {
      const value = args.shift();
      if (!value || Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--top-n requires a numeric value');
      }
      topN = Number(value);
    } else if (arg === '--min-shared') {
      const value = args.shift();
      if (!value || Number.isNaN(Number(value))) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--min-shared requires a numeric value');
      }
      minShared = Number(value);
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
  const storePath = resolve(runDir, 'run.sqlite');
  if (!existsSync(storePath)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Source run not found: ${sourceRunId} (missing ${storePath})`);
  }
  return runDir;
}

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  let store: RunStore | undefined;
  let sourceStore: RunStore | undefined;
  const signal: CancellationSignal = { cancelled: false };

  const sigintHandler = (): void => {
    if (signal.cancelled) {
      process.exit(EXIT_PAUSED);
    }
    (signal as { cancelled: boolean }).cancelled = true;
    console.log('');
    console.log('Stopping gracefully... solving.');
  };
  process.on('SIGINT', sigintHandler);

  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.resumeEnrichmentId) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', 'Resume for enrichment is not yet implemented');
    }

    if (!args.sourceRunId) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', '--run <source-run-id> is required');
    }

    loadConfig(process.env);
    const sourceRunDirectory = findSourceRunDirectory(args.sourceRunId);
    const sourceStorePath = resolve(sourceRunDirectory, 'run.sqlite');

    const enrichmentId = createRunId();
    const enrichmentDirectory = resolve(process.cwd(), 'enrichments', enrichmentId);
    createRunDirectory(enrichmentDirectory);

    store = RunStore.open(resolve(enrichmentDirectory, 'enrichment.sqlite'));

    const clusteringConfig: ClusteringConfig = {
      topN: args.topN,
      edgeRule: {
        minSharedDomains: args.minShared,
        minJaccard: args.minJaccard,
      },
      algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
    };

    const logger: EnrichmentLogger = (line: string) => {
      console.log(line);
    };

    console.log('Utility Research Runner — Enrichment');
    console.log('');

    const outcome = await runEnrichment({
      enrichmentId,
      sourceStoreOrPath: sourceStorePath,
      sourceRunId: args.sourceRunId,
      enrichmentStore: store,
      enrichmentDirectory,
      modules: args.modules,
      shortlist: args.shortlist,
      config: { clusters: clusteringConfig },
      logger,
      signal,
    });

    if (outcome.kind === 'paused') {
      console.log('Run paused. Resume with:');
      console.log(`  npm run enrich -- --resume ${enrichmentId}`);
      exitCode = EXIT_PAUSED;
    } else if (outcome.kind === 'completed' && outcome.result) {
      const clusters = outcome.result.clusters;
      const csvPath = resolve(enrichmentDirectory, 'keyword-clusters.csv');
      const jsonPath = resolve(enrichmentDirectory, 'keyword-clusters.json');

      await writeKeywordClustersCsv(csvPath, clusters);
      await writeKeywordClustersJson(jsonPath, {
        enrichmentId,
        outputDirectory: enrichmentDirectory,
        clusters,
        algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
        config: {
          topN: clusteringConfig.topN,
          edgeRule: clusteringConfig.edgeRule,
        },
      });

      console.log('');
      console.log(`Clusters: ${clusters.length}`);
      console.log(`Artifacts: ${enrichmentDirectory}/`);
      console.log(`  keyword-clusters.csv`);
      console.log(`  keyword-clusters.json`);
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
    sourceStore?.close();
    process.off('SIGINT', sigintHandler);
  }

  process.exit(exitCode);
}

main();
