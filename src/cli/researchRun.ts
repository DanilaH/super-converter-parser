import process from 'node:process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '../config/env.js';
import {
  DEFAULT_CLI_DEPS,
  EXIT_INTERNAL,
  EXIT_INVALID_INPUT,
  EXIT_OK,
  EXIT_PAUSED,
  runDiscovery,
  type CliDeps,
  type DiscoveryRunResult,
  type DiscoverySemanticConfig,
} from '../discovery/runDiscovery.js';
import {
  runConfiguredEnrichment,
  type ConfiguredEnrichmentResult,
} from '../enrichment/configuredRun.js';
import type { CancellationSignal } from '../enrichment/types.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { buildExistingResearchPlan, type ExistingResearchExecutionPlan } from '../operatorConfig/planner.js';
import {
  readOperatorConfigProvenance,
  writeOperatorConfigProvenance,
  type PersistedOperatorConfigV1,
} from '../operatorConfig/provenance.js';
import {
  loadOperatorContinuation,
  loadOperatorResearchConfig,
  type LoadedOperatorResearchConfig,
  type ResolvedOperatorContinuation,
} from '../operatorConfig/resolve.js';
import { buildResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

type ParsedArgs = {
  help: boolean;
  config: string | null;
  research: string | null;
  continuation: string | null;
  outputRoot: string | null;
  json: boolean;
};

export type ResearchRunWorkflowState =
  | 'completed'
  | 'awaiting_shortlist'
  | 'enrichment_paused'
  | 'enrichment_failed'
  | 'awaiting_finalization'
  | 'blocked';

export type ResearchRunMachineResultV1 = {
  version: 1;
  exitCode: number;
  researchId: string | null;
  discoveryRunId: string | null;
  discoveryState: string | null;
  enrichmentId: string | null;
  enrichmentState: string | null;
  workflowTarget: 'discovery' | 'enrichment' | 'finalization';
  workflowState: ResearchRunWorkflowState;
  stopPoint: 'discovery' | 'enrichment' | 'finalization' | 'complete';
  unresolvedHumanRequirements: Array<'shortlist' | 'finalist_scope' | 'human_decisions'>;
  effectiveConfigFingerprint: string;
  stageFingerprints: LoadedOperatorResearchConfig['plan']['stageFingerprints'];
  operatorConfigPath: string | null;
};

export type ResearchRunExecution = {
  exitCode: number;
  result: ResearchRunMachineResultV1;
};

export type ResearchRunDeps = {
  loadOperatorConfig: typeof loadOperatorResearchConfig;
  loadContinuation: typeof loadOperatorContinuation;
  loadProvenance: typeof readOperatorConfigProvenance;
  buildStatus: typeof buildResearchStatusWithHistoricalPresence;
  buildExistingPlan: typeof buildExistingResearchPlan;
  runDiscovery: typeof runDiscovery;
  runConfiguredEnrichment: typeof runConfiguredEnrichment;
  cliDeps: CliDeps;
  writeProvenance: typeof writeOperatorConfigProvenance;
};

export const DEFAULT_RESEARCH_RUN_DEPS: ResearchRunDeps = {
  loadOperatorConfig: loadOperatorResearchConfig,
  loadContinuation: loadOperatorContinuation,
  loadProvenance: readOperatorConfigProvenance,
  buildStatus: buildResearchStatusWithHistoricalPresence,
  buildExistingPlan: buildExistingResearchPlan,
  runDiscovery,
  runConfiguredEnrichment,
  cliDeps: DEFAULT_CLI_DEPS,
  writeProvenance: writeOperatorConfigProvenance,
};

export function parseResearchRunArgs(argv: string[]): ParsedArgs {
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
  if ((parsed.config === null) === (parsed.research === null)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Use exactly one of --config <path> or --research <research-id>.');
  }
  if (parsed.continuation !== null && parsed.research === null) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--continue is only valid with --research.');
  }
  return parsed;
}

export async function runResearchFromConfig(
  configPath: string,
  outputRoot: string | null,
  deps: ResearchRunDeps = DEFAULT_RESEARCH_RUN_DEPS,
  env: NodeJS.ProcessEnv = process.env,
  signal: CancellationSignal = { cancelled: false },
): Promise<ResearchRunExecution> {
  const loaded = await deps.loadOperatorConfig(configPath);
  const semantics = loaded.plan.semantics;
  const input = semantics.research.input;
  const semanticConfig = discoverySemanticConfig(loaded);

  console.log('Config-first research run');
  console.log(`  Config fingerprint: ${loaded.plan.effectiveConfigFingerprint}`);
  console.log(`  Workflow target: ${semantics.workflow.target}`);
  console.log('  Executing stage: discovery');
  console.log('');

  const discovery = await deps.runDiscovery(
    {
      input: input.type === 'microsoft'
        ? { kind: 'microsoft', path: input.resolvedPath }
        : { kind: 'seeds', path: input.resolvedPath },
      outputRoot,
      name: semantics.research.label,
      semanticConfig,
      onFreshResearchInitialized: async ({ researchDirectory }) => {
        await deps.writeProvenance(researchDirectory, loaded);
      },
    },
    deps.cliDeps,
    env,
  );

  if (discovery.exitCode !== EXIT_OK || discovery.runId === null || discovery.researchDirectory === null) {
    return { exitCode: discovery.exitCode, result: discoveryOnlyMachineResult(loaded, discovery) };
  }

  console.log('');
  console.log(`  Research ID: ${discovery.runId}`);
  console.log(`  Operator config: ${join(discovery.researchDirectory, 'operator-config.json')}`);

  if (semantics.workflow.target === 'discovery') {
    return { exitCode: EXIT_OK, result: discoveryOnlyMachineResult(loaded, discovery) };
  }

  return continueConfiguredWorkflow({
    researchId: discovery.runId,
    outputRoot,
    continuation: null,
    deps,
    env,
    signal,
    fallbackDiscovery: discovery,
  });
}

export async function runResearchFromExisting(
  researchId: string,
  continuationPath: string | null,
  outputRootValue: string | null,
  deps: ResearchRunDeps = DEFAULT_RESEARCH_RUN_DEPS,
  env: NodeJS.ProcessEnv = process.env,
  signal: CancellationSignal = { cancelled: false },
): Promise<ResearchRunExecution> {
  const outputRoot = resolveOutputRoot(outputRootValue, env);
  const status = await deps.buildStatus({ outputRoot, targetRunId: researchId });
  const continuation = continuationPath === null ? null : await deps.loadContinuation(continuationPath);
  return continueConfiguredWorkflow({
    researchId,
    outputRoot,
    continuation,
    deps,
    env,
    signal,
    prefetchedStatus: status,
  });
}

export async function runResearchRunCli(
  argv: string[],
  deps: ResearchRunDeps = DEFAULT_RESEARCH_RUN_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const signal: CancellationSignal = { cancelled: false };
  const cancel = (): void => {
    (signal as { cancelled: boolean }).cancelled = true;
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const parsed = parseResearchRunArgs(argv);
    if (parsed.help) {
      process.stdout.write(usage());
      return EXIT_OK;
    }
    const execution = parsed.config !== null
      ? await runResearchFromConfig(parsed.config, parsed.outputRoot, deps, env, signal)
      : await runResearchFromExisting(parsed.research as string, parsed.continuation, parsed.outputRoot, deps, env, signal);
    if (parsed.json) console.log(JSON.stringify(execution.result));
    return execution.exitCode;
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`${error.code}: ${error.message}`);
      const invalid = error.code === 'INPUT_SCHEMA_ERROR' || error.code === 'RESUME_NOT_FOUND' || error.code === 'RESUME_CONFIG_MISMATCH';
      return invalid ? EXIT_INVALID_INPUT : EXIT_INTERNAL;
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return EXIT_INTERNAL;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

type ContinueWorkflowArgs = {
  researchId: string;
  outputRoot: string | null;
  continuation: ResolvedOperatorContinuation | null;
  deps: ResearchRunDeps;
  env: NodeJS.ProcessEnv;
  signal: CancellationSignal;
  prefetchedStatus?: ResearchStatusWithHistoricalPresence;
  fallbackDiscovery?: DiscoveryRunResult;
};

async function continueConfiguredWorkflow(args: ContinueWorkflowArgs): Promise<ResearchRunExecution> {
  const outputRoot = resolveOutputRoot(args.outputRoot, args.env);
  const status = args.prefetchedStatus ?? await args.deps.buildStatus({ outputRoot, targetRunId: args.researchId });
  const provenance = await args.deps.loadProvenance(status.researchDirectory);
  if (provenance === null) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${args.researchId} has no persisted OperatorConfig provenance; config-driven continuation is unavailable.`,
    );
  }
  const plan = args.deps.buildExistingPlan(status, args.continuation, provenance);
  const base = existingMachineResult(status, provenance, plan);
  const enrichmentStage = plan.stages.find((stage) => stage.id === 'enrichment');
  if (!enrichmentStage) throw new ResearchError('OUTPUT_WRITE_ERROR', 'Existing research plan omitted the enrichment stage.');

  if (enrichmentStage.state === 'not_requested') {
    return { exitCode: EXIT_OK, result: { ...base, workflowState: 'completed', stopPoint: 'complete' } };
  }
  if (enrichmentStage.state === 'already_satisfied') {
    if (provenance.semantics.workflow.target === 'finalization') {
      return { exitCode: EXIT_OK, result: { ...base, workflowState: 'awaiting_finalization', stopPoint: 'finalization' } };
    }
    return { exitCode: EXIT_OK, result: { ...base, workflowState: 'completed', stopPoint: 'complete' } };
  }

  const currentEnrichment = status.currentEnrichmentId === null
    ? null
    : status.enrichments.find((item) => item.enrichmentId === status.currentEnrichmentId) ?? null;
  const resumableCurrent = currentEnrichment !== null
    && currentEnrichment.isForCurrentDiscovery
    && ['created', 'paused', 'failed'].includes(currentEnrichment.state);
  const shortlistRequired = plan.unresolvedHumanRequirements.includes('shortlist');

  if (shortlistRequired && !resumableCurrent) {
    console.log('  Stop point: configured enrichment requires an explicit shortlist continuation.');
    console.log(`  Continue with: npm run research:run -- --research ${status.researchId} --continue <shortlist-continuation.json>`);
    return {
      exitCode: EXIT_OK,
      result: { ...base, workflowState: 'awaiting_shortlist', stopPoint: 'enrichment' },
    };
  }

  if (enrichmentStage.state === 'blocked' && !resumableCurrent) {
    return { exitCode: EXIT_INVALID_INPUT, result: { ...base, exitCode: EXIT_INVALID_INPUT, workflowState: 'blocked', stopPoint: plan.expectedStopPoint === 'discovery' ? 'discovery' : 'enrichment' } };
  }

  const shortlistPath = args.continuation?.continuation.action.type === 'shortlist'
    ? args.continuation.declaredFilePath?.resolvedPath ?? null
    : null;

  console.log('  Executing stage: enrichment');
  if (resumableCurrent) console.log(`  Resuming enrichment: ${currentEnrichment.enrichmentId}`);
  const configured = await args.deps.runConfiguredEnrichment({
    outputRoot,
    researchId: status.researchId,
    researchDirectory: status.researchDirectory,
    sourceRunId: status.discovery.runId,
    currentEnrichmentId: resumableCurrent ? currentEnrichment.enrichmentId : null,
    operatorConfig: provenance,
    shortlistPath,
    env: args.env,
    signal: args.signal,
  });
  return machineResultAfterEnrichment(base, provenance, configured);
}

function machineResultAfterEnrichment(
  base: ResearchRunMachineResultV1,
  provenance: PersistedOperatorConfigV1,
  configured: ConfiguredEnrichmentResult,
): ResearchRunExecution {
  const outcome = configured.outcome;
  if (outcome.kind === 'paused') {
    return {
      exitCode: EXIT_PAUSED,
      result: {
        ...base,
        exitCode: EXIT_PAUSED,
        enrichmentId: configured.enrichmentId,
        enrichmentState: outcome.state,
        workflowState: 'enrichment_paused',
        stopPoint: 'enrichment',
      },
    };
  }
  if (outcome.kind === 'failed') {
    return {
      exitCode: EXIT_INTERNAL,
      result: {
        ...base,
        exitCode: EXIT_INTERNAL,
        enrichmentId: configured.enrichmentId,
        enrichmentState: outcome.state,
        workflowState: 'enrichment_failed',
        stopPoint: 'enrichment',
      },
    };
  }
  const awaitingFinalization = provenance.semantics.workflow.target === 'finalization';
  return {
    exitCode: EXIT_OK,
    result: {
      ...base,
      exitCode: EXIT_OK,
      enrichmentId: configured.enrichmentId,
      enrichmentState: outcome.state,
      workflowState: awaitingFinalization ? 'awaiting_finalization' : 'completed',
      stopPoint: awaitingFinalization ? 'finalization' : 'complete',
    },
  };
}

function discoverySemanticConfig(loaded: LoadedOperatorResearchConfig): DiscoverySemanticConfig {
  const semantics = loaded.plan.semantics;
  return {
    research: {
      market: semantics.research.market,
      googleHl: semantics.research.googleHl,
      googleGl: semantics.research.googleGl,
      topN: semantics.discovery.topN,
    },
    expansion: {
      enabled: semantics.discovery.expand,
      depth: semantics.discovery.expansionPolicy.depth,
      maxCandidatesPerKeyword: semantics.discovery.expansionPolicy.maxCandidatesPerKeyword,
      minOverlap: semantics.discovery.expansionPolicy.minOverlap,
      minVolume: semantics.discovery.expansionPolicy.minVolume,
    },
    requireAhrefs: semantics.discovery.requireAhrefs,
    scoring: { drThresholds: { ...semantics.discovery.scoringPolicy } },
  };
}

function discoveryOnlyMachineResult(
  loaded: LoadedOperatorResearchConfig,
  discovery: DiscoveryRunResult,
): ResearchRunMachineResultV1 {
  const target = loaded.plan.semantics.workflow.target;
  return {
    version: 1,
    exitCode: discovery.exitCode,
    researchId: discovery.researchId,
    discoveryRunId: discovery.runId,
    discoveryState: discovery.state,
    enrichmentId: null,
    enrichmentState: null,
    workflowTarget: target,
    workflowState: discovery.exitCode === EXIT_OK && target === 'discovery' ? 'completed' : 'blocked',
    stopPoint: discovery.exitCode === EXIT_OK && target === 'discovery' ? 'complete' : 'discovery',
    unresolvedHumanRequirements: loaded.plan.unresolvedHumanRequirements,
    effectiveConfigFingerprint: loaded.plan.effectiveConfigFingerprint,
    stageFingerprints: loaded.plan.stageFingerprints,
    operatorConfigPath: discovery.researchDirectory === null
      ? null
      : join(discovery.researchDirectory, 'operator-config.json'),
  };
}

function existingMachineResult(
  status: ResearchStatusWithHistoricalPresence,
  provenance: PersistedOperatorConfigV1,
  plan: ExistingResearchExecutionPlan,
): ResearchRunMachineResultV1 {
  const currentEnrichment = status.currentEnrichmentId === null
    ? null
    : status.enrichments.find((item) => item.enrichmentId === status.currentEnrichmentId) ?? null;
  return {
    version: 1,
    exitCode: EXIT_OK,
    researchId: status.researchId,
    discoveryRunId: status.discovery.runId,
    discoveryState: status.discovery.state,
    enrichmentId: currentEnrichment?.enrichmentId ?? null,
    enrichmentState: currentEnrichment?.state ?? null,
    workflowTarget: provenance.semantics.workflow.target,
    workflowState: 'blocked',
    stopPoint: plan.expectedStopPoint === 'complete' ? 'complete' : plan.expectedStopPoint,
    unresolvedHumanRequirements: plan.unresolvedHumanRequirements.filter(
      (value): value is 'shortlist' | 'finalist_scope' | 'human_decisions' => value !== 'operator_config',
    ),
    effectiveConfigFingerprint: provenance.effectiveConfigFingerprint,
    stageFingerprints: provenance.stageFingerprints,
    operatorConfigPath: join(status.researchDirectory, 'operator-config.json'),
  };
}

function nextValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  return value;
}

function usage(): string {
  return [
    'Utility Research Runner — config-first workflow execution',
    '',
    'Usage:',
    '  npm run research:run -- --config <research.config.json>',
    '  npm run research:run -- --config <research.config.json> --json',
    '  npm run research:run -- --research <research-id> [--continue continuation.json]',
    '  npm run research:run -- --research <research-id> --output-root <absolute-path> --json',
    '',
    'New research executes discovery and continues into configured enrichment when no human input is missing.',
    'Existing research is always selected by explicit stable research id; discovery run ids are resolved from durable state.',
    'Shortlist-dependent enrichment stops with workflowState=awaiting_shortlist until a typed shortlist continuation is supplied.',
    'Finalization execution remains gated for a later PR.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  process.exitCode = await runResearchRunCli(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
