import process from 'node:process';
import { existsSync } from 'node:fs';
import type { Browser } from 'playwright-core';
import { loadConfig, type ResearchConfig } from '../config/config.js';
import { connectResearchChrome, getPrimaryContext } from '../browser/cdp.js';
import { preflightGoogleAndSurfer } from '../browser/preflight.js';
import { loadSeedRows } from '../input/seeds/load.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { collectKeyword } from '../browser/collect.js';
import { executeRun, validateResume, type EngineHooks } from '../runs/engine.js';
import { RunStore } from '../db/store.js';
import { createRunDirectory, createRunId, ensureWritableDirectory } from '../runs/run.js';
import { ResearchError } from '../shared/errors.js';

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;
const EXIT_PREFLIGHT = 3;
// Documented stable code for a gracefully paused run (conventional Ctrl+C code).
const EXIT_PAUSED = 130;

type CliOptions = {
  seedsPath: string | null;
  resumeRunId: string | null;
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
  console.log('  SURFER_WAIT_MS               Max wait for Keyword Surfer data in ms (default 30000)');
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
  console.log('  BREAKER_SURFER_FAILURES      Surfer failures that pause the run (default 12)');
  console.log('  BREAKER_GOOGLE_CONSECUTIVE   Consecutive Google SERP parse failures that pause (default 10)');
  console.log('');
  console.log('Exit codes: 0 ok (incl. completed_with_errors), 1 internal, 2 invalid input/config,');
  console.log('3 preflight/environment, 130 gracefully paused (resume with --resume).');
}

function effectiveConfigForResume(
  current: ResearchConfig,
  persisted: ResearchConfig,
): ResearchConfig {
  // Semantic research settings come from the persisted snapshot; operational
  // settings (connection, timeouts, retries, breaker) use the current env.
  return { ...current, research: persisted.research };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.seedsPath && options.resumeRunId) {
    console.error('--seeds and --resume are mutually exclusive.');
    process.exitCode = EXIT_INVALID_INPUT;
    return;
  }
  if (!options.seedsPath && !options.resumeRunId) {
    printUsage();
    process.exitCode = EXIT_INVALID_INPUT;
    return;
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
    const config = loadConfig();

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
      runConfig = effectiveConfigForResume(config, run.configSnapshot);
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

    browser = await connectResearchChrome(runConfig.browser.cdpUrl);
    console.log(`  ✓ Research Chrome connected (${runConfig.browser.cdpUrl})`);

    const context = getPrimaryContext(browser);
    await preflightGoogleAndSurfer(context, runConfig);
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
        collectKeyword(context, runConfig, record, debugRootForKeyword),
      hooks,
    });

    if (outcome.kind === 'paused') {
      console.log('');
      console.log(`Run paused: ${outcome.reason}`);
      console.log('Resume with:');
      console.log(`  npm run research -- --resume ${runId}`);
      process.exitCode = EXIT_PAUSED;
    } else {
      process.exitCode = EXIT_OK;
    }
  } finally {
    store?.close();
    await browser?.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error('');
  console.error('Run failed:');

  if (error instanceof ResearchError) {
    console.error(`  ${error.code}: ${error.message}`);
    if (
      error.code === 'INPUT_SCHEMA_ERROR' ||
      error.code === 'RESUME_NOT_FOUND' ||
      error.code === 'RESUME_TERMINAL_RUN' ||
      error.code === 'RESUME_PARSER_MISMATCH'
    ) {
      process.exit(EXIT_INVALID_INPUT);
    } else if (
      error.code === 'BROWSER_CONNECTION_ERROR' ||
      error.code === 'SURFER_NOT_DETECTED' ||
      error.code === 'GOOGLE_UNAVAILABLE' ||
      error.code === 'CAPTCHA_REQUIRED' ||
      error.code === 'OUTPUT_WRITE_ERROR'
    ) {
      process.exit(EXIT_PREFLIGHT);
    } else {
      process.exit(EXIT_INTERNAL);
    }
    return;
  }

  console.error(error);
  process.exit(EXIT_INTERNAL);
});