import process from 'node:process';
import type { Browser } from 'playwright-core';
import { loadConfig } from '../config/config.js';
import { connectResearchChrome, getPrimaryContext } from '../browser/cdp.js';
import { preflightGoogleAndSurfer } from '../browser/preflight.js';
import { loadSeedRows } from '../input/seeds/load.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { collectKeyword } from '../browser/collect.js';
import {
  buildKeywordRecords,
  createRunId,
  ensureWritableDirectory,
  writeJsonFile,
  type KeywordRecord,
  type RunManifest,
} from '../runs/run.js';
import { ResearchError } from '../shared/errors.js';
import { GOOGLE_PARSER_VERSION, type SerpResult } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';

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
  await ensureWritableDirectory(runDirectory);
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

  const manifest: RunManifest = {
    runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: 'running',
    input: { kind: 'seeds', path: options.seedsPath },
    configSnapshot: config,
    parserVersions: {
      surfer: SURFER_PARSER_VERSION,
      google: GOOGLE_PARSER_VERSION,
    },
    progress: {
      totalKeywords: keywords.length,
      completedKeywords: 0,
      errors: 0,
    },
  };
  await writeJsonFile(`${runDirectory}/manifest.json`, manifest, 'run manifest');

  const records: KeywordRecord[] = buildKeywordRecords(keywords);
  const serpRows: SerpResult[] = [];
  const geoWarnings: string[] = [];

  for (let index = 0; index < keywords.length; index += 1) {
    const seed = keywords[index] as SeedKeyword;
    const record = records[index] as KeywordRecord;
    record.status = 'running';

    console.log(`[${index + 1}/${keywords.length}] ${seed.normalizedKeyword}`);
    const { record: result, serpRows: rowsForKeyword, debugArtifactPath } = await collectKeyword(
      context,
      config,
      record,
      debugRoot,
    );

    records.push(result);
    serpRows.push(...rowsForKeyword);

    if (result.surfer) {
      const volume = formatVolume(result.surfer.volume);
      const cpc = result.surfer.cpc === null ? 'n/a' : `$${result.surfer.cpc.toFixed(2)}`;
      console.log(`  ✓ volume: ${volume} | cpc: ${cpc} | organic: ${rowsForKeyword.length}`);
    } else {
      console.log(`  ✗ surfer: ${result.error?.code ?? 'unknown'} (${result.error?.message ?? ''})`);
    }

    if (result.google?.geoWarning) {
      const warning = `SERP GEO WARNING: target ${config.research.market}, Google detected location: ${result.google.detectedLocation}`;
      console.log(`  ⚠ ${warning}`);
      geoWarnings.push(`${result.normalizedKeyword}: ${warning}`);
    }

    if (debugArtifactPath) {
      console.log(`  ⚠ parser debug artifacts saved to ${debugArtifactPath}`);
    }

    manifest.progress.completedKeywords = records.length;
    manifest.progress.errors = records.filter((item) => item.status === 'failed').length;
    manifest.updatedAt = new Date().toISOString();
    await writeJsonFile(`${runDirectory}/manifest.json`, manifest, 'run manifest');
  }

  await writeJsonFile(`${runDirectory}/keywords.json`, records, 'keywords output');
  await writeJsonFile(`${runDirectory}/serp.json`, serpRows, 'SERP output');

  const failed = records.filter((item) => item.status === 'failed').length;
  const partial = records.filter((item) => item.status === 'partial').length;
  manifest.state = failed > 0 || partial > 0 ? 'completed_with_errors' : 'completed';
  manifest.updatedAt = new Date().toISOString();
  await writeJsonFile(`${runDirectory}/manifest.json`, manifest, 'run manifest');

  console.log('');
  if (geoWarnings.length > 0) {
    console.log(`Geo warnings (${geoWarnings.length}):`);
    for (const warning of geoWarnings) console.log(`  ⚠ ${warning}`);
    console.log('');
  }

  if (failed > 0 || partial > 0) {
    console.log(`Run finished with ${failed} failed and ${partial} partial keyword(s).`);
    for (const item of records) {
      if (item.status === 'failed' || item.status === 'partial') {
        console.log(`  ✗ ${item.normalizedKeyword}: ${item.error?.code} — ${item.error?.message}`);
      }
    }
  } else {
    console.log(`Run finished: ${records.length}/${keywords.length} keywords collected.`);
  }

  console.log(`Outputs: ${runDirectory}/manifest.json, keywords.json, serp.json`);
  process.exitCode = EXIT_OK;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

function formatVolume(volume: number | null): string {
  if (volume === null) return 'n/a';
  return volume.toLocaleString('en-US');
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