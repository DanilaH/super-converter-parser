import process from 'node:process';
import { join } from 'node:path';
import { loadDotEnv } from '../config/env.js';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import { saveCohortHistoricalPresenceSnapshot } from '../db/cohortHistoricalPresence.js';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
  resolveOutputRoot,
} from '../outputs/researchLayout.js';
import { HistoricalPresenceCache, defaultHistoricalPresenceCachePath } from '../historicalPresence/cache.js';
import { collectCohortHistoricalPresence } from '../historicalPresence/cohortCollector.js';
import { createCommonCrawlHistoricalPresenceClient } from '../historicalPresence/commonCrawl.js';
import {
  writeCohortHistoricalPresenceCsv,
  writeCohortHistoricalPresenceJson,
} from '../historicalPresence/cohortOutputs.js';
import { publishCohortHistoricalPresenceMetadata } from '../historicalPresence/cohortPublication.js';
import {
  DEFAULT_HISTORICAL_PRESENCE_CONFIG,
  type HistoricalPresenceCollectionMode,
} from '../historicalPresence/types.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  enrichmentId: string;
  outputRoot: string | null;
  collectionMode: HistoricalPresenceCollectionMode;
  recentMonths: number;
  maxCollections: number;
  domainCap: number;
};

function nextValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  return value;
}

function positiveInt(raw: string, option: string, max?: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `${option} must be an integer from 1${max === undefined ? '' : ` to ${max}`}; got ${raw}.`,
    );
  }
  return value;
}

export function parseCohortHistoricalPresenceArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = {
    help: false,
    enrichmentId: '',
    outputRoot: null,
    collectionMode: DEFAULT_HISTORICAL_PRESENCE_CONFIG.collectionMode,
    recentMonths: DEFAULT_HISTORICAL_PRESENCE_CONFIG.recentMonths,
    maxCollections: DEFAULT_HISTORICAL_PRESENCE_CONFIG.maxCollections,
    domainCap: 30,
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--enrichment') parsed.enrichmentId = nextValue(args, '--enrichment');
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg === '--collection-mode') {
      const value = nextValue(args, '--collection-mode');
      if (value !== 'latest' && value !== 'annual') {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `--collection-mode must be latest or annual; got ${value}.`);
      }
      parsed.collectionMode = value;
    } else if (arg === '--recent-months') {
      parsed.recentMonths = positiveInt(nextValue(args, '--recent-months'), '--recent-months', 120);
    } else if (arg === '--max-collections') {
      parsed.maxCollections = positiveInt(nextValue(args, '--max-collections'), '--max-collections', 100);
    } else if (arg === '--domain-cap') {
      parsed.domainCap = positiveInt(nextValue(args, '--domain-cap'), '--domain-cap', 100);
    } else if (arg?.startsWith('-')) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    } else if (arg) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
    }
  }
  if (!parsed.help && parsed.enrichmentId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--enrichment <id> is required.');
  }
  return parsed;
}

function printUsage(): void {
  console.log('Utility Research Sampled Historical Presence');
  console.log('');
  console.log('Usage:');
  console.log('  npm run cohort-historical-presence -- --enrichment <enrichment-id> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --collection-mode <latest|annual>  Common Crawl collection traversal (default annual).');
  console.log('  --recent-months <1..120>           Recent crawls retained by annual sampling (default 18).');
  console.log('  --max-collections <1..100>         Bound selected Common Crawl indexes (default 24).');
  console.log('  --domain-cap <1..100>              Bound unique entrant domains checked (default 30).');
  console.log('  --output-root <path>               Durable research output root.');
  console.log('  --help, -h                         Show help.');
  console.log('');
  console.log('Semantics: earliest sampled Common Crawl presence is bounded archive evidence, NOT exact first-seen.');
}

async function main(): Promise<void> {
  const args = parseCohortHistoricalPresenceArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const outputRoot = resolveOutputRoot(args.outputRoot);
  const location = await resolveEnrichmentLocation(outputRoot, args.enrichmentId);
  const store = RunStore.open(join(location.enrichmentDirectory, 'enrichment.sqlite'));
  const appConfig = loadConfig();
  const cachePath = defaultHistoricalPresenceCachePath(appConfig.cache.path);
  const cache = HistoricalPresenceCache.open(cachePath);

  try {
    const enrichment = store.loadEnrichmentRun(args.enrichmentId);
    if (!enrichment) throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${args.enrichmentId}`);
    if (enrichment.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Sampled historical presence requires a completed enrichment; ${args.enrichmentId} is ${enrichment.state}.`,
      );
    }
    const entrant = loadEntrantCohortState(store, args.enrichmentId);
    if (!entrant) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${args.enrichmentId} has no persisted entrant cohort. Run npm run entrant-cohort first.`,
      );
    }

    const config = {
      ...DEFAULT_HISTORICAL_PRESENCE_CONFIG,
      collectionMode: args.collectionMode,
      recentMonths: args.recentMonths,
      maxCollections: args.maxCollections,
    };
    const client = createCommonCrawlHistoricalPresenceClient(config);
    const collection = await collectCohortHistoricalPresence({
      cohorts: entrant.cohorts,
      client,
      cache,
      domainCap: args.domainCap,
    });
    const snapshot = {
      enrichmentId: args.enrichmentId,
      sourceRunId: entrant.sourceRunId,
      entrantRepresentativeRevision: entrant.representativeRevision,
      entrantFingerprint: entrantCohortFingerprint(entrant),
      collectionVersion: collection.version,
      config: { ...config, domainCap: args.domainCap },
      collection,
    };
    const saved = saveCohortHistoricalPresenceSnapshot(store, snapshot);

    const csvPath = join(location.enrichmentDirectory, 'cohort-historical-presence.csv');
    const jsonPath = join(location.enrichmentDirectory, 'cohort-historical-presence.json');
    await writeCohortHistoricalPresenceCsv(csvPath, snapshot);
    await writeCohortHistoricalPresenceJson(jsonPath, snapshot);
    await publishCohortHistoricalPresenceMetadata({
      enrichmentDirectory: location.enrichmentDirectory,
      snapshot,
      changed: saved.changed,
    });
    await archiveResearchDirectory(location.researchDirectory);

    const summary = collection.summary;
    console.log(
      `Sampled historical presence: ${summary.checkedDomainCount}/${summary.uniqueDomainCount} entrant domain(s) checked, `
      + `${summary.omittedDomainCount} cap-omitted.`,
    );
    console.log(
      `Observed=${summary.knownPresenceDomainCount}, not_found=${summary.notFoundDomainCount}, `
      + `unavailable=${summary.unavailableDomainCount}, error=${summary.errorDomainCount}.`,
    );
    console.log(
      `Complete selected-history observations=${summary.completeSelectedHistoryDomainCount}/${summary.knownPresenceDomainCount}; `
      + `cache hits=${summary.cacheHitCount}; domain lookup requests=${summary.networkRequestCount}.`,
    );
    console.log('Semantics: earliestSampledCaptureAt is bounded sampled Common Crawl evidence, not exact first-seen.');
    console.log(`Artifacts: ${csvPath}, ${jsonPath}`);
  } finally {
    cache.close();
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/cohortHistoricalPresence.ts') || process.argv[1]?.endsWith('\\cohortHistoricalPresence.ts')) {
  main()
    .then(() => {
      process.exitCode = EXIT_OK;
    })
    .catch((error) => {
      if (error instanceof ResearchError) {
        console.error(`${error.code}: ${error.message}`);
        process.exitCode = error.code === 'INPUT_SCHEMA_ERROR' ? EXIT_INVALID_INPUT : EXIT_INTERNAL;
        return;
      }
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = EXIT_INTERNAL;
    });
}
