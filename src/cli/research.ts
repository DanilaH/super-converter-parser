import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '../config/env.js';
import { ResearchError } from '../shared/errors.js';
import {
  DEFAULT_CLI_DEPS,
  EXIT_INTERNAL,
  EXIT_INVALID_INPUT,
  EXIT_OK,
  EXIT_PAUSED,
  EXIT_PREFLIGHT,
  effectiveConfigForResume,
  runDiscovery,
  type CliDeps,
  type DiscoveryRunRequest,
} from '../discovery/runDiscovery.js';

loadDotEnv();

export {
  DEFAULT_CLI_DEPS,
  EXIT_INTERNAL,
  EXIT_INVALID_INPUT,
  EXIT_OK,
  EXIT_PAUSED,
  EXIT_PREFLIGHT,
  effectiveConfigForResume,
  type CliDeps,
};

type CliOptions = {
  seedsPath: string | null;
  microsoftPath: string | null;
  resumeRunId: string | null;
  retryFailed: boolean;
  forceRefresh: boolean;
  refreshKeywords: string[];
  expand: boolean;
  jsonStatus: boolean;
  requireAhrefs: boolean;
  outputRoot: string | null;
  name: string | null;
};

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    seedsPath: null,
    microsoftPath: null,
    resumeRunId: null,
    retryFailed: false,
    forceRefresh: false,
    refreshKeywords: [],
    expand: false,
    jsonStatus: false,
    requireAhrefs: false,
    outputRoot: null,
    name: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--seeds') {
      options.seedsPath = optionValue(argv, index, '--seeds');
      index += 1;
    } else if (arg === '--microsoft') {
      options.microsoftPath = optionValue(argv, index, '--microsoft');
      index += 1;
    } else if (arg === '--resume') {
      options.resumeRunId = optionValue(argv, index, '--resume');
      index += 1;
    } else if (arg === '--retry-failed') {
      options.retryFailed = true;
    } else if (arg === '--force-refresh') {
      options.forceRefresh = true;
    } else if (arg === '--expand' || arg === '--expand-surfer') {
      options.expand = true;
    } else if (arg === '--json-status') {
      options.jsonStatus = true;
    } else if (arg === '--require-ahrefs') {
      options.requireAhrefs = true;
    } else if (arg === '--output-root') {
      options.outputRoot = optionValue(argv, index, '--output-root');
      index += 1;
    } else if (arg === '--name') {
      options.name = optionValue(argv, index, '--name');
      index += 1;
    } else if (arg === '--refresh-keyword') {
      options.refreshKeywords.push(optionValue(argv, index, '--refresh-keyword'));
      index += 1;
    } else {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function runCli(
  argv: string[],
  deps: CliDeps = DEFAULT_CLI_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`Run failed:\n  ${error.code}: ${error.message}`);
      return EXIT_INVALID_INPUT;
    }
    throw error;
  }

  if (options.seedsPath && options.resumeRunId) {
    console.error('--seeds and --resume are mutually exclusive.');
    return EXIT_INVALID_INPUT;
  }
  if (options.microsoftPath && options.resumeRunId) {
    console.error('--microsoft and --resume are mutually exclusive.');
    return EXIT_INVALID_INPUT;
  }
  if (options.seedsPath && options.microsoftPath) {
    console.error('--seeds and --microsoft are mutually exclusive.');
    return EXIT_INVALID_INPUT;
  }
  if (options.retryFailed && !options.resumeRunId) {
    console.error('--retry-failed requires --resume <run-id>.');
    return EXIT_INVALID_INPUT;
  }
  if (!options.seedsPath && !options.microsoftPath && !options.resumeRunId) {
    printUsage();
    return EXIT_INVALID_INPUT;
  }

  const input: DiscoveryRunRequest['input'] = options.resumeRunId
    ? { kind: 'resume', runId: options.resumeRunId }
    : options.microsoftPath
      ? { kind: 'microsoft', path: options.microsoftPath }
      : { kind: 'seeds', path: options.seedsPath as string };

  const result = await runDiscovery(
    {
      input,
      retryFailed: options.retryFailed,
      forceRefresh: options.forceRefresh,
      refreshKeywords: options.refreshKeywords,
      expand: options.expand,
      jsonStatus: options.jsonStatus,
      requireAhrefs: options.requireAhrefs,
      outputRoot: options.outputRoot,
      name: options.name,
    },
    deps,
    env,
  );
  return result.exitCode;
}

function printUsage(): void {
  console.log('Utility Research Runner');
  console.log('');
  console.log('Usage:');
  console.log('  npm run research -- --seeds <path>');
  console.log('  npm run research -- --seeds <path> --force-refresh');
  console.log('  npm run research -- --seeds <path> --refresh-keyword "json diff"');
  console.log('  npm run research -- --microsoft <path>');
  console.log('  npm run research -- --resume <run-id>');
  console.log('  npm run research -- --resume <run-id> --retry-failed');
  console.log('');
  console.log('Options:');
  console.log('  --seeds <path>       Path to a CSV file with a required "keyword" column.');
  console.log('  --microsoft <path>   Path to a Microsoft Keyword Planner CSV export (requires a "Keyword" column).');
  console.log('  --resume <run-id>    Continue a paused or interrupted run (--seeds is not required).');
  console.log('  --retry-failed       With --resume, repair failed or provably incomplete partial primary checkpoints, preserving attempt history.');
  console.log('  --force-refresh      Ignore the persistent cache for every keyword of this run.');
  console.log('  --expand             Enable Keyword Surfer related-keyword expansion (depth 1).');
  console.log('  --expand-surfer      Alias for --expand (clarity flag).');
  console.log('  --require-ahrefs     Require Ahrefs DR: fail if AHREFS_API_KEY is missing/blank.');
  console.log('  --output-root <path> Absolute durable output root (overrides RESEARCH_OUTPUT_ROOT).');
  console.log('  --name <label>       Human-readable research folder label.');
  console.log('  --json-status        Print a single compact JSON status line as the final stdout line.');
  console.log('  --refresh-keyword <q> Re-collect this keyword even if cached (repeatable; it must be one of the run keywords).');
  console.log('');
  console.log('Environment:');
  console.log('  RESEARCH_OUTPUT_ROOT         Durable output root (default <home>/super-converter-parser-output)');
  console.log('  CDP_URL                      Research Chrome debugging endpoint (default http://127.0.0.1:9333)');
  console.log('  SURFER_WAIT_MS               Max wait for Keyword Surfer data in ms (default 60000)');
  console.log('  SURFER_PREFLIGHT_TIMEOUT_MS  Max wait for Surfer injection during preflight in ms (default 60000)');
  console.log('  NAVIGATION_TIMEOUT_MS        Page load timeout in ms (default 60000)');
  console.log('  RESEARCH_MARKET              Surfer market label (default US)');
  console.log('  GOOGLE_HL                    Google interface language (default en)');
  console.log('  GOOGLE_GL                    Google country parameter (default us)');
  console.log('  TOP_N                        Integer organic results per keyword (default 10, range 1..30)');
  console.log('  SURFER_WIDGET_SELECTOR       Override Surfer main widget selector (testing hook)');
  console.log('  SURFER_RELATED_WIDGET_SELECTOR Override Surfer related-keywords widget selector');
  console.log('  EXPANSION_ENABLED            Enable Surfer related-keyword expansion (true/false)');
  console.log('  EXPANSION_DEPTH              Expansion depth (only 1 is currently supported)');
  console.log('  EXPANSION_MAX_CANDIDATES     Max related candidates per keyword (default 20)');
  console.log('  EXPANSION_MIN_OVERLAP        Drop candidates with lower overlap (default 0)');
  console.log('  EXPANSION_MIN_VOLUME         Drop candidates with lower volume (default 0)');
  console.log('  RETRY_MAX_ATTEMPTS           Max collection attempts per keyword (default 3)');
  console.log('  RETRY_BASE_DELAY_MS          Initial retry backoff (default 1000)');
  console.log('  RETRY_MAX_DELAY_MS           Retry backoff cap (default 15000)');
  console.log('  BREAKER_SURFER_WINDOW        Surfer failure window (default 15)');
  console.log('  BREAKER_SURFER_FAILURES      Surfer failures that pause the run (default 12, at most BREAKER_SURFER_WINDOW)');
  console.log('  BREAKER_GOOGLE_CONSECUTIVE   Consecutive Google SERP parse failures that pause (default 10)');
  console.log('  CACHE_DB_PATH                Persistent cache database (default data/cache/cache.sqlite)');
  console.log('  CACHE_TTL_COMPLETED_MS       Cache TTL for completed keywords in ms (default 7d)');
  console.log('  CACHE_TTL_PARTIAL_MS         Cache TTL for partial keywords in ms (default 6h)');
  console.log('  CACHE_TTL_FAILED_MS          Cache TTL for failed keywords in ms (default 1h)');
  console.log('  CACHE_TTL_RELATED_MS         Cache TTL for related keywords in ms (default 7d)');
  console.log('  CACHE_TTL_RELATED_ERROR_MS   Cache TTL for failed related-keyword expansions in ms (default 1h)');
  console.log('  CACHE_TTL_DOMAIN_OK_MS       Cache TTL for successful DR lookups in ms (default 30d)');
  console.log('  CACHE_TTL_DOMAIN_NOT_FOUND_MS Cache TTL for not-found DR lookups in ms (default 30d)');
  console.log('  REQUIRE_AHREFS               Require Ahrefs DR (true/false); fail early without a key');
  console.log('');
  console.log('Exit codes: 0 ok (incl. completed_with_errors), 1 internal, 2 invalid input/config,');
  console.log('3 preflight/environment, 130 gracefully paused (resume with --resume).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error);
      process.exitCode = EXIT_INTERNAL;
    },
  );
}
