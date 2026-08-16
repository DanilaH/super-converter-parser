import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import type { Browser, BrowserContext } from 'playwright-core';
import { loadConfig, type ResearchConfig } from '../config/config.js';
import { connectResearchChrome, getPrimaryContext } from '../browser/cdp.js';
import { preflightGoogleAndSurfer } from '../browser/preflight.js';
import { loadSeedRows } from '../input/seeds/load.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { collectKeyword, type CollectionResult } from '../browser/collect.js';
import { executeRun, validateResume, type EngineHooks } from '../runs/engine.js';
import { RunStore } from '../db/store.js';
import { createRunDirectory, createRunId, ensureWritableDirectory, type KeywordRecord } from '../runs/run.js';
import { ResearchError } from '../shared/errors.js';

export const EXIT_OK = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_INVALID_INPUT = 2;
export const EXIT_PREFLIGHT = 3;
// Documented stable code for a gracefully paused run (conventional Ctrl+C code).
export const EXIT_PAUSED = 130;

type CliOptions = {
  seedsPath: string | null;
  resumeRunId: string | null;
};

// Browser-side pieces are injected so the CLI flow can be integration-tested
// without a Chrome instance; the defaults are the production implementations.
export type CliDeps = {
  connect: (cdpUrl: string) => Promise<Browser>;
  preflight: (context: BrowserContext, config: ResearchConfig) => Promise<void>;
  collect: (
    context: BrowserContext,
    config: ResearchConfig,
    record: KeywordRecord,
    debugRoot: string,
  ) => Promise<CollectionResult>;
};

export const DEFAULT_CLI_DEPS: CliDeps = {
  connect: connectResearchChrome,
  preflight: preflightGoogleAndSurfer,
  collect: collectKeyword,
};

function parseArgs(argv: string[]): CliOptions {
  const seedsIndex = argv.indexOf('--seeds');
  const resumeIndex = argv.indexOf('--resume');
  return {
    seedsPath: seedsIndex >= 0 ? argv[seedsIndex + 1] ?? null : null,
    resumeRunId: resumeIndex >= 0 ? argv[resumeIndex + 1] ?? null : null,
  };
}

function printUsage(): void {
  console.log('Utility Research Runner');
  console.log('');
  console.log('Usage:');
  console.log('  npm run research -- --seeds <path>');
  console.log('  npm run research -- --resume <run-id>');
  console.log('');
  console.log('Options:');
  console.log('  --seeds <path>    Path to a CSV file with a required "keyword" column.');
  console.log('  --resume <run-id> Continue a paused or interrupted run (--seeds is not required).');
  console.log('');
  console.log('Environment:');
  console.log('  CDP_URL                      Research Chrome debugging endpoint (default http://127.0.0.1:9222)');
  console.log('  SURFER_WAIT_MS               Max wait for Keyword Surfer data in ms (default 60000)');
  console.log('  SURFER_PREFLIGHT_TIMEOUT_MS  Max wait for Surfer injection during preflight in ms (default 60000)');
  console.log('  NAVIGATION_TIMEOUT_MS        Page load timeout in ms (default 60000)');
  console.log('  RESEARCH_MARKET              Surfer market label (default US)');
  console.log('  GOOGLE_HL                    Google interface language (default en)');
  console.log('  GOOGLE_GL                    Google country parameter (default us)');
  console.log('  TOP_N                        Max organic results per keyword (default 10, max 30)');
  console.log('  SURFER_WIDGET_SELECTOR       Override Surfer main widget selector (testing hook)');
  console.log('  RETRY_MAX_ATTEMPTS           Max collection attempts per keyword (default 3)');
  console.log('  RETRY_BASE_DELAY_MS          Initial retry backoff (default 1000)');
  console.log('  RETRY_MAX_DELAY_MS           Retry backoff cap (default 15000)');
  console.log('  BREAKER_SURFER_WINDOW        Surfer failure window (default 15)');
  console.log('  BREAKER_SURFER_FAILURES      Surfer failures that pause the run (default 12, at most BREAKER_SURFER_WINDOW)');
  console.log('  BREAKER_GOOGLE_CONSECUTIVE   Consecutive Google SERP parse failures that pause (default 10)');
  console.log('');
  console.log('Exit codes: 0 ok (incl. completed_with_errors), 1 internal, 2 invalid input/config,');
  console.log('3 preflight/environment, 130 gracefully paused (resume with --resume).');
}

// A resume must not mix parser settings with the current run. The widget
// selector is a parser-setting, so changing it mid-run is refused.
export function effectiveConfigForResume(
  current: ResearchConfig,
  persisted: ResearchConfig,
  runId: string,
): ResearchConfig {
  if (current.browser.surferWidgetSelector !== persisted.browser.surferWidgetSelector) {
    throw new ResearchError(
      'RESUME_CONFIG_MISMATCH',
      `Run "${runId}" persisted SURFER_WIDGET_SELECTOR "${persisted.browser.surferWidgetSelector}" but the current value is "${current.browser.surferWidgetSelector}". Start a new run instead; the widget selector must not change between resume attempts.`,
    );
  }
  // Semantic research settings come from the persisted snapshot; operational
  // settings (connection, timeouts, retries, breaker) use the current env.
  return { ...current, research: persisted.research };
}

function exitCodeForError(error: ResearchError): number {
  switch (error.code) {
    case 'INPUT_SCHEMA_ERROR':
    case 'RESUME_NOT_FOUND':
    case 'RESUME_TERMINAL_RUN':
    case 'RESUME_PARSER_MISMATCH':
    case 'RESUME_CONFIG_MISMATCH':
      return EXIT_INVALID_INPUT;
    case 'BROWSER_CONNECTION_ERROR':
    case 'SURFER_NOT_DETECTED':
    case 'GOOGLE_UNAVAILABLE':
    case 'CAPTCHA_REQUIRED':
    case 'OUTPUT_WRITE_ERROR':
      return EXIT_PREFLIGHT;
    default:
      return EXIT_INTERNAL;
  }
}

export async function runCli(
  argv: string[],
  deps: CliDeps = DEFAULT_CLI_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const options = parseArgs(argv);

  if (options.seedsPath && options.resumeRunId) {
    console.error('--seeds and --resume are mutually exclusive.');
    return EXIT_INVALID_INPUT;
  }
  if (!options.seedsPath && !options.resumeRunId) {
    printUsage();
    return EXIT_INVALID_INPUT;
  }

  let pauseRequested = false;
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      console.log('');
      console.log('Stopping... (Ctrl+C again to force quit)');
      pauseRequested = true;
    } else {
      process.removeAllListeners('SIGINT');
      process.kill(process.pid, 'SIGINT');
    }
  });

  let browser: Browser | null = null;
  let store: RunStore | null = null;
  try {
    const config = loadConfig(env);

    let runId: string;
    let runDirectory: string;
    let debugRoot: string;
    let mode: 'fresh' | 'resume';
    let keywords: SeedKeyword[] = [];
    let input: { kind: 'seeds'; path: string };
    let runConfig = config;

    if (options.resumeRunId) {
      runId = options.resumeRunId;
      runDirectory = `runs/${runId}`;
      debugRoot = `debug/${runId}`;
      mode = 'resume';

      const storePath = `${runDirectory}/run.sqlite`;
      if (!existsSync(storePath)) {
        throw new ResearchError(
          'RESUME_NOT_FOUND',
          `No run store found for run "${runId}" (expected ${storePath}). Use --seeds to start a new run.`,
        );
      }
      store = RunStore.open(storePath);
      const run = validateResume(store, runId);
      runConfig = effectiveConfigForResume(config, run.configSnapshot, runId);
      input = run.input;

      console.log('Utility Research Runner');
      console.log('');
      console.log(`[resume] ${runId} (state: ${run.state}, parser ${run.parserVersions.surfer}/${run.parserVersions.google})`);
      await ensureWritableDirectory(runDirectory);
      console.log(`  ✓ runs/${runId} writable`);
      await ensureWritableDirectory(debugRoot);
      console.log(`  ✓ debug/${runId} writable`);
    } else {
      runId = createRunId();
      runDirectory = `runs/${runId}`;
      debugRoot = `debug/${runId}`;
      mode = 'fresh';
      input = { kind: 'seeds', path: options.seedsPath as string };

      console.log('Utility Research Runner');
      console.log('');
      console.log('[preflight]');
      await createRunDirectory(runDirectory);
      console.log(`  ✓ runs/${runId} writable`);
      await ensureWritableDirectory(debugRoot);
      console.log(`  ✓ debug/${runId} writable`);
      store = RunStore.open(`${runDirectory}/run.sqlite`);
      console.log(`  ✓ runs/${runId}/run.sqlite initialized (schema v${store.version})`);
    }

    browser = await deps.connect(runConfig.browser.cdpUrl);
    console.log(`  ✓ Research Chrome connected (${runConfig.browser.cdpUrl})`);

    const context = getPrimaryContext(browser);
    await deps.preflight(context, runConfig);
    console.log('  ✓ Google reachable');
    console.log(`  ✓ Keyword Surfer injection detected; configured market: ${runConfig.research.market}`);

    if (mode === 'fresh') {
      const rows = await loadSeedRows(options.seedsPath as string);
      keywords = buildSeedKeywords(rows);
      console.log(`  Input: ${rows.length} rows, ${keywords.length} unique keywords`);
      console.log('');
    }

    const hooks: EngineHooks = {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      random: Math.random,
      logger: (line) => console.log(line),
      pauseRequested: () => pauseRequested,
    };

    const outcome = await executeRun({
      store,
      runId,
      mode,
      keywords,
      config: runConfig,
      input,
      runDirectory,
      debugRoot,
      collect: (record, debugRootForKeyword) =>
        deps.collect(context, runConfig, record, debugRootForKeyword),
      hooks,
    });

    if (outcome.kind === 'paused') {
      console.log('');
      console.log(`Run paused: ${outcome.reason}`);
      console.log('Resume with:');
      console.log(`  npm run research -- --resume ${runId}`);
      return EXIT_PAUSED;
    }
    return EXIT_OK;
  } catch (error) {
    console.error('');
    console.error('Run failed:');
    if (error instanceof ResearchError) {
      console.error(`  ${error.code}: ${error.message}`);
      return exitCodeForError(error);
    }
    console.error(error);
    return EXIT_INTERNAL;
  } finally {
    store?.close();
    await browser?.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = EXIT_INTERNAL;
    },
  );
}
