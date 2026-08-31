import process from 'node:process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createWaybackClient } from '../firstseen/wayback.js';
import { createCommonCrawlHistoryClient, type CommonCrawlCollectionMode } from '../spikes/historicalSources/commonCrawl.js';
import {
  groupHistoricalDomains,
  parseHistoricalDomainFixture,
  renderHistoricalSpikeCsv,
  renderHistoricalSpikeMarkdown,
  runHistoricalSourceSpike,
} from '../spikes/historicalSources/spike.js';
import { writeJsonAtomic, writeTextAtomic } from '../runs/run.js';

const DEFAULT_INPUT = 'fixtures/v2-2/historical-source-domains.csv';
const DEFAULT_RECENT_MONTHS = 18;
const DEFAULT_MAX_COLLECTIONS = 48;
const DEFAULT_REQUEST_BUDGET = 2_500;

interface Args {
  help: boolean;
  input: string;
  output: string | null;
  collectionMode: CommonCrawlCollectionMode;
  recentMonths: number;
  maxCollections: number | null;
  requestBudget: number;
  allowLargeScan: boolean;
  maxDomains: number | null;
}

function valueAfter(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}

function positiveInt(raw: string, option: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${option} requires a positive integer.`);
  return value;
}

function parseArgs(argv: string[]): Args {
  const args = [...argv];
  const parsed: Args = {
    help: false,
    input: DEFAULT_INPUT,
    output: null,
    collectionMode: 'annual',
    recentMonths: DEFAULT_RECENT_MONTHS,
    maxCollections: DEFAULT_MAX_COLLECTIONS,
    requestBudget: DEFAULT_REQUEST_BUDGET,
    allowLargeScan: false,
    maxDomains: null,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--input') parsed.input = valueAfter(args, '--input');
    else if (arg === '--output') parsed.output = valueAfter(args, '--output');
    else if (arg === '--collection-mode') {
      const value = valueAfter(args, '--collection-mode');
      if (value !== 'latest' && value !== 'annual' && value !== 'all') {
        throw new Error(`--collection-mode must be latest, annual, or all (got "${value}").`);
      }
      parsed.collectionMode = value;
    } else if (arg === '--recent-months') {
      parsed.recentMonths = positiveInt(valueAfter(args, '--recent-months'), '--recent-months');
    } else if (arg === '--max-collections') {
      const value = valueAfter(args, '--max-collections');
      parsed.maxCollections = value === 'all' ? null : positiveInt(value, '--max-collections');
    } else if (arg === '--request-budget') {
      parsed.requestBudget = positiveInt(valueAfter(args, '--request-budget'), '--request-budget');
    } else if (arg === '--allow-large-scan') {
      parsed.allowLargeScan = true;
    } else if (arg === '--max-domains') {
      const value = positiveInt(valueAfter(args, '--max-domains'), '--max-domains');
      if (value > 100) throw new Error('--max-domains must be at most 100.');
      parsed.maxDomains = value;
    } else if (arg?.startsWith('-')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (arg) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  return parsed;
}

function defaultOutputDirectory(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return resolve('data', 'spikes', `historical-source-${stamp}`);
}

function printUsage(): void {
  console.log('V2.2 Historical Source Spike');
  console.log('');
  console.log('Usage:');
  console.log('  npm run spike:history -- [options]');
  console.log('');
  console.log('Options:');
  console.log(`  --input <csv>                Persisted real-domain fixture (default ${DEFAULT_INPUT})`);
  console.log('  --output <dir>               Output directory (default data/spikes/historical-source-<timestamp>)');
  console.log('  --collection-mode <mode>     latest | annual | all (default annual)');
  console.log(`  --recent-months <n>          Recent crawls kept in annual mode (default ${DEFAULT_RECENT_MONTHS})`);
  console.log(`  --max-collections <n|all>    Bound selected crawl indexes (default ${DEFAULT_MAX_COLLECTIONS})`);
  console.log(`  --request-budget <n>         Max planned Common Crawl collection checks (default ${DEFAULT_REQUEST_BUDGET})`);
  console.log('  --allow-large-scan           Explicitly allow a plan above the request budget');
  console.log('  --max-domains <1..100>       Explicit smoke subset; full decision run normally uses 50-100 unique domains');
  console.log('  -h, --help                   Show help');
  console.log('');
  console.log('Truth note: annual/latest Common Crawl modes are bounded sampled-history evidence, not exact first-ever capture timestamps.');
}

function selectRowsByDomainLimit<T extends { domain: string }>(rows: T[], maxDomains: number | null): T[] {
  if (maxDomains === null) return rows;
  const domains = Array.from(new Set(rows.map((row) => row.domain))).sort((a, b) => a.localeCompare(b));
  const allowed = new Set(domains.slice(0, maxDomains));
  return rows.filter((row) => allowed.has(row.domain));
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }

  try {
    const inputPath = resolve(args.input);
    const fixture = await readFile(inputPath, 'utf8');
    const allRows = parseHistoricalDomainFixture(fixture);
    const rows = selectRowsByDomainLimit(allRows, args.maxDomains);
    const uniqueDomains = groupHistoricalDomains(rows).length;
    const fullDecisionSample = args.maxDomains === null;
    if (fullDecisionSample && (uniqueDomains < 50 || uniqueDomains > 100)) {
      throw new Error(`PR-01 decision fixture must contain 50-100 unique domains; got ${uniqueDomains}. Use --max-domains only for an explicit smoke subset.`);
    }

    const outputDirectory = args.output ? resolve(args.output) : defaultOutputDirectory();
    await mkdir(outputDirectory, { recursive: true });

    const commonCrawl = createCommonCrawlHistoryClient({
      timeoutMs: 15_000,
      minDelayMs: 250,
      maxAttempts: 2,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
    });
    const wayback = createWaybackClient({
      provider: 'wayback',
      endpoint: '',
      apiKey: null,
      timeoutMs: 15_000,
      minDelayMs: 1_000,
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 15_000,
    });

    console.log('V2.2 Historical Source Spike');
    console.log('');
    console.log(`Input: ${inputPath}`);
    console.log(`Unique domains: ${uniqueDomains}${fullDecisionSample ? ' (decision-sized fixture)' : ' (explicit smoke subset)'}`);
    console.log(`Common Crawl mode: ${args.collectionMode}`);
    console.log(`Output: ${outputDirectory}`);
    console.log('');

    const result = await runHistoricalSourceSpike(
      {
        rows,
        collectionMode: args.collectionMode,
        recentMonths: args.recentMonths,
        maxCollections: args.maxCollections,
        requestBudget: args.requestBudget,
        allowLargeScan: args.allowLargeScan,
      },
      { commonCrawl, wayback },
    );

    await writeJsonAtomic(
      join(outputDirectory, 'historical-source-spike.json'),
      result,
      'historical source spike JSON',
    );
    await writeTextAtomic(
      join(outputDirectory, 'historical-source-spike.csv'),
      renderHistoricalSpikeCsv(result),
      'historical source spike CSV',
    );
    await writeTextAtomic(
      join(outputDirectory, 'historical-source-spike-report.md'),
      renderHistoricalSpikeMarkdown(result),
      'historical source spike report',
    );

    console.log('Completed evidence collection.');
    console.log(`Common Crawl observed: ${result.providerSummary.commonCrawl.ok}/${result.providerSummary.commonCrawl.denominator}`);
    console.log(`Wayback observed: ${result.providerSummary.wayback.ok}/${result.providerSummary.wayback.denominator}`);
    console.log('Decision remains PENDING HUMAN REVIEW; inspect the generated report before PROMOTE/DEFER.');
  } catch (error) {
    console.error(`Historical source spike failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
