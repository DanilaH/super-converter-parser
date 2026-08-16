import process from 'node:process';
import type { Browser } from 'playwright-core';
import { loadConfig } from '../config/config.js';
import { connectResearchChrome, getPrimaryContext } from '../browser/cdp.js';
import { preflightGoogleAndSurfer } from '../browser/preflight.js';
import { loadSeedRows } from '../input/seeds/load.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { collectKeyword } from '../browser/collect.js';
import { runKeywordBatch } from '../runs/orchestrator.js';
import { createRunDirectory, createRunId, ensureWritableDirectory } from '../runs/run.js';
import { ResearchError } from '../shared/errors.js';

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;
const EXIT_PREFLIGHT = 3;

type CliOptions = {
  seedsPath: string | null;
};

function parseArgs(argv: string[]): CliOptions {
  const seedsIndex = argv.indexOf('--seeds');
  const seedsPath = seedsIndex >= 0 ? argv[seedsIndex + 1] ?? null : null;
  return { seedsPath };
}

function printUsage(): void {
  console.log('Utility Research Runner');
  console.log('');
  console.log('Usage:');
  console.log('  npm run research -- --seeds <path>');
  console.log('');
  console.log('Options:');
  console.log('  --seeds <path>  Path to a CSV file with a required "keyword" column.');
  console.log('');
  console.log('Environment:');
  console.log('  CDP_URL                  Research Chrome debugging endpoint (default http://127.0.0.1:9222)');
  console.log('  SURFER_WAIT_MS           Max wait for Keyword Surfer data in ms (default 30000)');
  console.log('  NAVIGATION_TIMEOUT_MS    Page load timeout in ms (default 60000)');
  console.log('  RESEARCH_MARKET          Surfer market label (default US)');
  console.log('  GOOGLE_HL                Google interface language (default en)');
  console.log('  GOOGLE_GL                Google country parameter (default us)');
  console.log('  TOP_N                    Max organic results per keyword (default 10, max 30)');
  console.log('  SURFER_WIDGET_SELECTOR   Override Surfer main widget selector (testing hook)');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.seedsPath) {
    printUsage();
    process.exitCode = EXIT_INVALID_INPUT;
    return;
  }

  let browser: Browser | null = null;
  try {
    const config = loadConfig();
  const runId = createRunId();
  const runDirectory = `runs/${runId}`;
  const debugRoot = `debug/${runId}`;

  console.log('Utility Research Runner');
  console.log('');

  console.log('[preflight]');
  await createRunDirectory(runDirectory);
  console.log(`  ✓ runs/${runId} writable`);
  await ensureWritableDirectory(debugRoot);
  console.log(`  ✓ debug/${runId} writable`);

  browser = await connectResearchChrome(config.browser.cdpUrl);
  console.log(`  ✓ Research Chrome connected (${config.browser.cdpUrl})`);

  const context = getPrimaryContext(browser);
  await preflightGoogleAndSurfer(context, config);
  console.log('  ✓ Google reachable');
  console.log(`  ✓ Keyword Surfer injection detected; configured market: ${config.research.market}`);

  const rows = await loadSeedRows(options.seedsPath);
  const keywords = buildSeedKeywords(rows);
  console.log(`  Input: ${rows.length} rows, ${keywords.length} unique keywords`);
  console.log('');

  await runKeywordBatch(
    runId,
    config,
    keywords,
    { kind: 'seeds', path: options.seedsPath },
    runDirectory,
    debugRoot,
    (record, debugRootForKeyword) => collectKeyword(context, config, record, debugRootForKeyword),
  );
  process.exitCode = EXIT_OK;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error('');
  console.error('Run failed:');

  if (error instanceof ResearchError) {
    console.error(`  ${error.code}: ${error.message}`);
    if (error.code === 'INPUT_SCHEMA_ERROR') {
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
