import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '../config/env.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { buildResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';
import { buildExistingResearchPlan, renderResearchPlan, type ResearchExecutionPlan } from '../operatorConfig/planner.js';
import { readOperatorConfigProvenance } from '../operatorConfig/provenance.js';
import { loadOperatorContinuation, loadOperatorResearchConfig } from '../operatorConfig/resolve.js';

loadDotEnv();

export const EXIT_OK = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_INVALID_INPUT = 2;

type ParsedArgs = { help: boolean; config: string | null; research: string | null; continuation: string | null; outputRoot: string | null; json: boolean };
export type ResearchPlanDeps = {
  loadConfig: typeof loadOperatorResearchConfig;
  loadContinuation: typeof loadOperatorContinuation;
  loadProvenance: typeof readOperatorConfigProvenance;
  buildStatus: typeof buildResearchStatusWithHistoricalPresence;
};
export const DEFAULT_RESEARCH_PLAN_DEPS: ResearchPlanDeps = {
  loadConfig: loadOperatorResearchConfig,
  loadContinuation: loadOperatorContinuation,
  loadProvenance: readOperatorConfigProvenance,
  buildStatus: buildResearchStatusWithHistoricalPresence,
};

export function parseResearchPlanArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = { help: false, config: null, research: null, continuation: null, outputRoot: null, json: false };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--config') parsed.config = nextValue(args, '--config');
    else if (arg === '--research') parsed.research = nextValue(args, '--research');
    else if (arg === '--continue') parsed.continuation = nextValue(args, '--continue');
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg === '--json') parsed.json = true;
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }
  if (parsed.help) return parsed;
  if ((parsed.config === null) === (parsed.research === null)) throw new ResearchError('INPUT_SCHEMA_ERROR', 'Use exactly one of --config <path> or --research <research-id>.');
  if (parsed.continuation !== null && parsed.research === null) throw new ResearchError('INPUT_SCHEMA_ERROR', '--continue is only valid with --research.');
  return parsed;
}

export async function buildPlanFromArgs(parsed: ParsedArgs, deps: ResearchPlanDeps = DEFAULT_RESEARCH_PLAN_DEPS, env: NodeJS.ProcessEnv = process.env): Promise<ResearchExecutionPlan> {
  if (parsed.config !== null) return (await deps.loadConfig(parsed.config)).plan;
  if (parsed.research === null) throw new ResearchError('INPUT_SCHEMA_ERROR', '--research is required for existing-research planning.');
  const outputRoot = resolveOutputRoot(parsed.outputRoot, env);
  const status = await deps.buildStatus({ outputRoot, targetRunId: parsed.research });
  const continuation = parsed.continuation === null ? null : await deps.loadContinuation(parsed.continuation);
  const provenance = await deps.loadProvenance(status.researchDirectory);
  return buildExistingResearchPlan(status, continuation, provenance);
}

export async function runResearchPlanCli(argv: string[], deps: ResearchPlanDeps = DEFAULT_RESEARCH_PLAN_DEPS, env: NodeJS.ProcessEnv = process.env): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const parsed = parseResearchPlanArgs(argv);
    if (parsed.help) return { exitCode: EXIT_OK, stdout: usage(), stderr: '' };
    const plan = await buildPlanFromArgs(parsed, deps, env);
    return { exitCode: EXIT_OK, stdout: parsed.json ? `${JSON.stringify(plan, null, 2)}\n` : renderResearchPlan(plan), stderr: '' };
  } catch (error) {
    if (error instanceof ResearchError) {
      const invalid = error.code === 'INPUT_SCHEMA_ERROR' || error.code === 'RESUME_NOT_FOUND';
      return { exitCode: invalid ? EXIT_INVALID_INPUT : EXIT_INTERNAL, stdout: '', stderr: `${error.code}: ${error.message}\n` };
    }
    return { exitCode: EXIT_INTERNAL, stdout: '', stderr: `${error instanceof Error ? error.stack ?? error.message : String(error)}\n` };
  }
}

function usage(): string {
  return [
    'Utility Research Planner',
    '',
    'Usage:',
    '  npm run research:plan -- --config <research.config.json>',
    '  npm run research:plan -- --config <research.config.json> --json',
    '  npm run research:plan -- --research <research-id> [--continue continuation.json]',
    '',
    'Options:',
    '  --config <path>       Plan a new research from OperatorResearchConfigV1.',
    '  --research <id>       Inspect/plan an existing research by explicit stable identity.',
    '  --continue <path>     Validate a typed continuation against that exact research.',
    '  --output-root <path>  Durable output root for existing-research lookup.',
    '  --json                Print the machine-readable plan.',
    '  --help, -h            Show this help.',
    '',
    'This command is read-only: it does not start Chrome, call providers, create research state, mutate caches, apply continuation inputs, or publish artifacts.',
    '',
  ].join('\n');
}

function nextValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  return value;
}

async function main(): Promise<void> {
  const result = await runResearchPlanCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
