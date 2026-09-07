import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { listResearchLibrary, type ResearchLibraryList } from '../library/query.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
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

export function parseLibraryListArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = { help: false, outputRoot: null, json: false };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg === '--json') parsed.json = true;
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }
  return parsed;
}

function printUsage(): void {
  console.log('Utility Research Library List');
  console.log('');
  console.log('Usage:');
  console.log('  npm run library:list');
  console.log('');
  console.log('Options:');
  console.log('  --output-root <path> Durable research output root.');
  console.log('  --json               Print the read-only Library projection as JSON.');
  console.log('  --help, -h           Show this help.');
  console.log('');
  console.log('This command reads library.sqlite only; derived library.json is not used as current truth.');
}

export function renderResearchLibraryList(value: ResearchLibraryList): string {
  const lines = [
    'Research Library',
    `  Database: ${value.libraryDbPath}`,
    `  Initialized: ${value.initialized ? 'yes' : 'no'}`,
    `  Logical researches: ${value.researchCount}`,
    `  Publications: ${value.publicationCount}`,
    '',
    'Researches',
  ];
  if (value.researches.length === 0) {
    lines.push('  none');
  } else {
    for (const research of value.researches) {
      const current = research.currentPublication;
      lines.push(`  ${research.researchPath}`);
      lines.push(`    name=${research.researchName} versions=${research.versionCount}`);
      lines.push(`    current=${current.publicationId} published=${current.publishedAt}`);
      lines.push(`    source=${current.sourceRunId} enrichment=${current.enrichmentId}`);
      lines.push(`    counts keywords=${current.counts.keywords} clusters=${current.counts.clusters} finalists=${current.counts.finalists} entrantDomains=${current.counts.entrantDomains}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  try {
    const args = parseLibraryListArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }
    const outputRoot = resolveOutputRoot(args.outputRoot, process.env);
    const result = await listResearchLibrary(outputRoot);
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderResearchLibraryList(result));
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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/libraryList.ts') || process.argv[1]?.endsWith('\\libraryList.ts')) {
  void main();
}
