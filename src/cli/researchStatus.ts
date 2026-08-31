import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { buildResearchStatus, type ResearchStatus } from '../research/status.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  research: string;
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

export function parseResearchStatusArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = { help: false, research: '', outputRoot: null, json: false };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--research') parsed.research = nextValue(args, '--research');
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg === '--json') parsed.json = true;
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }
  if (!parsed.help && parsed.research === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--research <research-id-or-run-id> is required.');
  }
  return parsed;
}

function printUsage(): void {
  console.log('Utility Research Status');
  console.log('');
  console.log('Usage:');
  console.log('  npm run research:status -- --research <research-id-or-run-id>');
  console.log('');
  console.log('Options:');
  console.log('  --research <id>      Stable research id or any discovery run id in that research.');
  console.log('  --output-root <path> Durable research output root.');
  console.log('  --json               Print the full read-only status projection as JSON.');
  console.log('  --help, -h           Show this help.');
  console.log('');
  console.log('This command is read-only: it never resumes, repairs, finalizes, publishes, or rewrites research state.');
}

function countLine(status: ResearchStatus): string {
  const c = status.discovery.keywordCounts;
  return `keywords=${c.total} completed=${c.completed} partial=${c.partial} failed=${c.failed} pending=${c.pending} running=${c.running} repairable=${c.repairable}`;
}

function moduleLine(status: ResearchStatus['enrichments'][number]): string {
  const parts = Object.entries(status.itemCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, counts]) => {
      const total = counts.pending + counts.running + counts.completed + counts.error + counts.notAttempted;
      return `${module}:${counts.completed}/${total}${counts.error > 0 ? ` error=${counts.error}` : ''}${counts.pending + counts.running > 0 ? ` open=${counts.pending + counts.running}` : ''}`;
    });
  return parts.length > 0 ? parts.join(' | ') : 'no persisted module items';
}

export function renderResearchStatus(status: ResearchStatus): string {
  const lines: string[] = [
    'Research status',
    `  Research: ${status.researchId} (${status.label})`,
    `  Layout: ${status.legacy ? 'legacy' : 'current'}`,
    `  Directory: ${status.researchDirectory}`,
    '',
    `Discovery #${status.discovery.generation}`,
    `  Run: ${status.discovery.runId}`,
    `  State: ${status.discovery.state}${status.discovery.pauseReason ? ` (${status.discovery.pauseReason})` : ''}`,
    `  ${countLine(status)}`,
  ];

  if (status.discovery.qualityWarnings.length === 0) {
    lines.push('  Quality warnings: none');
  } else {
    lines.push(`  Quality warnings: ${status.discovery.qualityWarnings.length}`);
    for (const warning of status.discovery.qualityWarnings) {
      lines.push(`    - ${warning.code}: ${warning.message}`);
    }
  }

  lines.push('', 'Enrichments');
  if (status.enrichments.length === 0) {
    lines.push('  none');
  } else {
    for (const enrichment of status.enrichments) {
      const flags = [
        enrichment.isForCurrentDiscovery ? 'current-discovery' : 'historical-discovery',
        enrichment.isLatestForCurrentDiscovery ? 'latest' : null,
      ].filter((value): value is string => value !== null).join(', ');
      lines.push(`  #${enrichment.generation} ${enrichment.enrichmentId}: ${enrichment.state} [${flags}]`);
      lines.push(`    ${moduleLine(enrichment)}`);
      if (enrichment.error) lines.push(`    error: ${enrichment.error}`);
    }
  }

  lines.push('', 'Finalization');
  lines.push(`  State: ${status.finalization.state}`);
  if (status.finalization.enrichmentId) lines.push(`  Enrichment: ${status.finalization.enrichmentId}`);
  if (status.finalization.finalistCount > 0) {
    lines.push(`  Current decisions: ${status.finalization.currentDecisionCount}/${status.finalization.finalistCount}`);
  }
  lines.push(`  Finalist matrix published: ${status.finalization.finalistMatrixPublished ? 'yes' : 'no'}`);
  if (status.finalization.artifactWarning) lines.push(`  Artifact warning: ${status.finalization.artifactWarning}`);

  lines.push('', 'Research Library');
  if (status.library.published) {
    lines.push(`  Publication: ${status.library.publicationId ?? 'unknown'}${status.library.publishedAt ? ` @ ${status.library.publishedAt}` : ''}`);
  } else {
    lines.push(`  Publication: none${status.library.reason ? ` (${status.library.reason})` : ''}`);
  }
  if (status.library.lookupError) lines.push(`  Lookup warning: ${status.library.lookupError}`);

  lines.push('', 'Next operator action');
  lines.push(`  ${status.nextAction.message}`);
  if (status.nextAction.command) lines.push(`  ${status.nextAction.command}`);
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  try {
    const args = parseResearchStatusArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }
    const outputRoot = resolveOutputRoot(args.outputRoot, process.env);
    const status = await buildResearchStatus({ outputRoot, targetRunId: args.research });
    process.stdout.write(args.json ? `${JSON.stringify(status, null, 2)}\n` : renderResearchStatus(status));
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`${error.code}: ${error.message}`);
      exitCode = error.code === 'INPUT_SCHEMA_ERROR' || error.code === 'RESUME_NOT_FOUND'
        ? EXIT_INVALID_INPUT
        : EXIT_INTERNAL;
    } else {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      exitCode = EXIT_INTERNAL;
    }
  } finally {
    process.exitCode = exitCode;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/researchStatus.ts') || process.argv[1]?.endsWith('\\researchStatus.ts')) {
  void main();
}
