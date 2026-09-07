import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import { inspectResearchLibraryLineage, type ResearchLibraryLineage } from '../library/query.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  outputRoot: string | null;
  researchPath: string;
  json: boolean;
};

function nextValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  }
  return value;
}

export function parseLibraryInspectArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = { help: false, outputRoot: null, researchPath: '', json: false };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg === '--research-path') parsed.researchPath = nextValue(args, '--research-path');
    else if (arg === '--json') parsed.json = true;
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }
  if (!parsed.help && parsed.researchPath === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--research-path <relative-path> is required. Use library:list to discover available paths.');
  }
  return parsed;
}

function printUsage(): void {
  console.log('Utility Research Library Inspect');
  console.log('');
  console.log('Usage:');
  console.log('  npm run library:inspect -- --research-path <relative-research-path>');
  console.log('');
  console.log('Options:');
  console.log('  --research-path <path> Exact persisted research_relative_path from library:list.');
  console.log('  --output-root <path>   Durable research output root.');
  console.log('  --json                 Print the immutable publication lineage as JSON.');
  console.log('  --help, -h             Show this help.');
  console.log('');
  console.log('This command is read-only and resolves one logical research by persisted Library path, never by display-name heuristics.');
}

export function renderResearchLibraryLineage(value: ResearchLibraryLineage): string {
  const lines = [
    'Research Library lineage',
    `  Research: ${value.researchName}`,
    `  Path: ${value.researchPath}`,
    `  Versions: ${value.versionCount}`,
    `  Database: ${value.libraryDbPath}`,
    '',
    'Publications',
  ];
  for (const publication of value.publications) {
    lines.push(`  #${publication.versionNumber}${publication.current ? ' [current]' : ''} ${publication.publicationId}`);
    lines.push(`    published=${publication.publishedAt} supersedes=${publication.supersedesPublicationId ?? 'none'}`);
    lines.push(`    source=${publication.sourceRunId} enrichment=${publication.enrichmentId}`);
    lines.push(`    fingerprint=${publication.snapshotFingerprint}`);
    lines.push(`    counts keywords=${publication.counts.keywords} clusters=${publication.counts.clusters} finalists=${publication.counts.finalists} entrantDomains=${publication.counts.entrantDomains}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  try {
    const args = parseLibraryInspectArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }
    const outputRoot = resolveOutputRoot(args.outputRoot, process.env);
    const result = await inspectResearchLibraryLineage({
      outputRoot,
      researchPath: args.researchPath,
    });
    process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderResearchLibraryLineage(result));
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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/libraryInspect.ts') || process.argv[1]?.endsWith('\\libraryInspect.ts')) {
  void main();
}
