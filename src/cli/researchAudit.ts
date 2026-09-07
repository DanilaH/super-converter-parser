import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import {
  buildFailedResearchAudit,
  buildResearchAudit,
  type ResearchAudit,
} from '../research/audit.js';
import { buildResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_AUDIT_FAIL = 1;
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

export function parseResearchAuditArgs(argv: string[]): ParsedArgs {
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
  console.log('Utility Research Integrity Audit');
  console.log('');
  console.log('Usage:');
  console.log('  npm run research:audit -- --research <research-id-or-run-id>');
  console.log('');
  console.log('Options:');
  console.log('  --research <id>      Stable research id or any discovery run id in that research.');
  console.log('  --output-root <path> Durable research output root.');
  console.log('  --json               Print the audit projection as JSON.');
  console.log('  --help, -h           Show this help.');
  console.log('');
  console.log('This command is read-only. WARN means degraded/incomplete/unknown evidence, not corruption.');
  console.log('FAIL is reserved for unsafe/stale integrity state or a failed durable read/projection.');
}

export function renderResearchAudit(audit: ResearchAudit): string {
  const lines = [
    'Research audit',
    `  Research: ${audit.researchId}${audit.label ? ` (${audit.label})` : ''}`,
    `  Layout: ${audit.legacy === null ? 'unknown' : audit.legacy ? 'legacy' : 'current'}`,
    `  Overall: ${audit.overall.toUpperCase()}`,
    '',
    'Checks',
  ];
  for (const check of audit.checks) {
    lines.push(`  [${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  let parsed: ParsedArgs | null = null;
  try {
    parsed = parseResearchAuditArgs(process.argv.slice(2));
    if (parsed.help) {
      printUsage();
      return;
    }
    const outputRoot = resolveOutputRoot(parsed.outputRoot, process.env);
    const status = await buildResearchStatusWithHistoricalPresence({
      outputRoot,
      targetRunId: parsed.research,
    });
    const audit = buildResearchAudit(status);
    process.stdout.write(parsed.json ? `${JSON.stringify(audit, null, 2)}\n` : renderResearchAudit(audit));
    if (audit.overall === 'fail') exitCode = EXIT_AUDIT_FAIL;
  } catch (error) {
    if (
      error instanceof ResearchError
      && (error.code === 'INPUT_SCHEMA_ERROR' || error.code === 'RESUME_NOT_FOUND')
    ) {
      console.error(`${error.code}: ${error.message}`);
      exitCode = EXIT_INVALID_INPUT;
    } else {
      const code = error instanceof ResearchError ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      const audit = buildFailedResearchAudit({
        targetResearchId: parsed?.research || 'unknown',
        code,
        message,
      });
      if (parsed?.json) process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
      else process.stderr.write(renderResearchAudit(audit));
      exitCode = EXIT_AUDIT_FAIL;
    }
  } finally {
    process.exitCode = exitCode;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/researchAudit.ts') || process.argv[1]?.endsWith('\\researchAudit.ts')) {
  void main();
}
