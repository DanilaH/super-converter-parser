import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '../config/env.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';
import { importGscSearchTraction, type ImportGscSearchTractionResult } from '../searchTraction/import.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

export type SearchTractionImportArgs = {
  help: boolean;
  inputPath: string;
  property: string;
  outputRoot: string | null;
  json: boolean;
};

function nextValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  }
  return value;
}

export function parseSearchTractionImportArgs(argv: string[]): SearchTractionImportArgs {
  const args = [...argv];
  const parsed: SearchTractionImportArgs = {
    help: false,
    inputPath: '',
    property: '',
    outputRoot: null,
    json: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--input') parsed.inputPath = nextValue(args, '--input');
    else if (arg === '--property') parsed.property = nextValue(args, '--property');
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg === '--json') parsed.json = true;
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }

  if (!parsed.help && parsed.inputPath === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--input <gsc-export.zip> is required.');
  }
  if (!parsed.help && parsed.property.trim() === '') {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      '--property <property-id> is required and must be explicit; property identity is not inferred from the ZIP filename.',
    );
  }
  return parsed;
}

export function renderSearchTractionImport(result: ImportGscSearchTractionResult): string {
  const observed = result.observedRange
    ? `${result.observedRange.startDate}..${result.observedRange.endDate}`
    : 'none';
  const filterText = result.filters.length === 0
    ? 'none'
    : result.filters.map((filter) => `${filter.name}=${filter.value}`).join('; ');
  const queryCoverage = formatRatio(result.coverage.query.impressionCoverageRatio);
  const pageCoverage = formatRatio(result.coverage.page.impressionCoverageRatio);

  return [
    'First-party Search Traction — GSC import',
    `  Snapshot: ${result.snapshotId}`,
    `  Property: ${result.property}`,
    `  Changed: ${result.changed ? 'yes' : 'no (duplicate source snapshot)'}`,
    `  Observed chart range: ${observed}`,
    `  Export filters: ${filterText}`,
    `  Totals: ${result.totals.clicks} clicks / ${result.totals.impressions} impressions`,
    `  Rows: chart=${result.rowCounts.chart} queries=${result.rowCounts.queries} pages=${result.rowCounts.pages} countries=${result.rowCounts.countries} devices=${result.rowCounts.devices} searchAppearance=${result.rowCounts.searchAppearance}`,
    `  Impression coverage: queries=${queryCoverage} pages=${pageCoverage}`,
    `  SQLite: ${result.databasePath}`,
    `  Source archive: ${result.sourceArchivePath}`,
    `  Stored snapshots: ${result.snapshotCount}`,
    '',
  ].join('\n');
}

function printUsage(): void {
  console.log('Utility Research Runner — First-party Search Traction Import');
  console.log('');
  console.log('Usage:');
  console.log('  npm run search-traction:import -- --input <gsc-export.zip> --property <property-id>');
  console.log('');
  console.log('Options:');
  console.log('  --input <path>       Google Search Console Performance export ZIP.');
  console.log('  --property <id>      Explicit Search Console property identifier; never inferred from filename.');
  console.log('  --output-root <path> Durable Runner output root.');
  console.log('  --json               Print import result as JSON.');
  console.log('  --help, -h           Show this help.');
  console.log('');
  console.log('The import keeps Chart/query/page/country/device/search-appearance aggregates separate; it never fabricates cross-dimensional rows.');
}

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  try {
    const args = parseSearchTractionImportArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }
    const outputRoot = resolveOutputRoot(args.outputRoot, process.env);
    const result = await importGscSearchTraction({
      outputRoot,
      inputPath: args.inputPath,
      property: args.property,
    });
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderSearchTractionImport(result));
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`${error.code}: ${error.message}`);
      exitCode = error.code === 'INPUT_SCHEMA_ERROR' ? EXIT_INVALID_INPUT : EXIT_INTERNAL;
    } else {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      exitCode = EXIT_INTERNAL;
    }
  } finally {
    process.exitCode = exitCode;
  }
}

function formatRatio(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
