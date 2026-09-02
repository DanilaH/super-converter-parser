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
import {
  runConfiguredFinalization,
  type ConfiguredFinalizationResult,
} from '../finalization/configuredRun.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { acquireResearchExecutionLock } from '../operatorConfig/executionLock.js';
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
  | 'awaiting_finalist_scope'
  | 'awaiting_decisions'
  | 'blocked';

export type ResearchRunMachineResultV1 = {
  version: 1;
  exitCode: number;
  researchId: string | null;
  discoveryRunId: string | null;
  discoveryState: string | null;
  enrichmentId: string | null;
  enrichmentState: string | null;
  finalizationState: string | null;
  publicationId: string | null;
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
  acquireExecutionLock: typeof acquireResearchExecutionLock;
  runDiscovery: typeof runDiscovery;
  runConfiguredEnrichment: typeof runConfiguredEnrichment;
  runConfiguredFinalization: typeof runConfiguredFinalization;
  cliDeps: CliDeps;
  writeProvenance: typeof writeOperatorConfigProvenance;
};

export const DEFAULT_RESEARCH_RUN_DEPS: ResearchRunDeps = {
  loadOperatorConfig: loadOperatorResearchConfig,
  loadContinuation: loadOperatorContinuation,
  loadProvenance: readOperatorConfigProvenance,
  buildStatus: buildResearchStatusWithHistoricalPresence,
  buildExistingPlan: buildExistingResearchPlan,
  acquireExecutionLock: acquireResearchExecutionLock,
  runDiscovery,
  runConfiguredEnrichment,
  runConfiguredFinalization,
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
  const researchId = discovery.runId;

  console.log('');
  console.log(`  Research ID: ${researchId}`);
  console.log(`  Operator config: ${join(discovery.researchDirectory, 'operator-config.json')}`);

  if (semantics.workflow.target === 'discovery') {
    return { exitCode: EXIT_OK, result: discoveryOnlyMachineResult(loaded, discovery) };
  }

  return continueConfiguredWorkflow({
    researchId,
    outputRoot,
    continuation: null,
    deps,
    env,
    signal,
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
  try {
    const parsed = parseResearchRunArgs(argv);
    if (parsed.help) {
      process.stdout.write(usage());
      return EXIT_OK;
    }
    const signal: CancellationSignal = { cancelled: false };
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
};

async function continueConfiguredWorkflow(args: ContinueWorkflowArgs): Promise<ResearchRunExecution> {
  const outputRoot = resolveOutputRoot(args.outputRoot, args.env);
  const initialStatus = args.prefetchedStatus ?? await args.deps.buildStatus({ outputRoot, targetRunId: args.researchId });
  const releaseLock = await args.deps.acquireExecutionLock(outputRoot, initialStatus.researchId);
  try {
    const status = await args.deps.buildStatus({ outputRoot, targetRunId: args.researchId });
    return continueConfiguredWorkflowUnderLock(args, outputRoot, status);
  } finally {
    await releaseLock();
  }
}

async function continueConfiguredWorkflowUnderLock(
  args: ContinueWorkflowArgs,
  outputRoot: string,
  status: ResearchStatusWithHistoricalPresence,
): Promise<ResearchRunExecution> {
  const provenance = await args.deps.loadProvenance(status.researchDirectory);
  if (provenance === null) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${args.researchId} has no persisted OperatorConfig provenance; config-driven continuation is unavailable.`,
    );
  }
  const plan = args.deps.buildExistingPlan(status, args.continuation, provenance);
  const base = existingMachineResult(status, provenance, plan);
  const discoveryStage = plan.stages.find((stage) => stage.id === 'discovery');
  if (!discoveryStage) throw new ResearchError('OUTPUT_WRITE_ERROR', 'Existing research plan omitted the discovery stage.');

  if (discoveryStage.state === 'ready') {
    if (args.continuation !== null) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        'A continuation input cannot be consumed until the current configured discovery is complete.',
      );
    }
    console.log(`  Resuming discovery: ${status.discovery.runId}`);
    const discovery = await args.deps.runDiscovery(
      {
        input: { kind: 'resume', runId: status.discovery.runId },
        outputRoot,
      },
      args.deps.cliDeps,
      args.env,
    );
    if (discovery.exitCode !== EXIT_OK) {
      return {
        exitCode: discovery.exitCode,
        result: {
          ...base,
          exitCode: discovery.exitCode,
          discoveryRunId: discovery.runId ?? status.discovery.runId,
          discoveryState: discovery.state ?? status.discovery.state,
          workflowState: 'blocked',
          stopPoint: 'discovery',
        },
      };
    }

    // Discovery resume changes the durable parent state. Re-read SQLite and
    // rebuild the canonical plan while the same per-research execution lock is
    // still held before any downstream stage can run.
    const refreshedStatus = await args.deps.buildStatus({
      outputRoot,
      targetRunId: status.researchId,
    });
    return continueConfiguredWorkflowUnderLock(args, outputRoot, refreshedStatus);
  }

  const enrichmentStage = plan.stages.find((stage) => stage.id === 'enrichment');
  if (!enrichmentStage) throw new ResearchError('OUTPUT_WRITE_ERROR', 'Existing research plan omitted the enrichment stage.');

  if (enrichmentStage.state === 'not_requested') {
    return { exitCode: EXIT_OK, result: { ...base, workflowState: 'completed', stopPoint: 'complete' } };
  }
  if (enrichmentStage.state === 'already_satisfied') {
    if (provenance.semantics.workflow.target === 'finalization') {
      return advanceConfiguredFinalization(args, outputRoot, status, provenance, plan, base);
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
    return {
      exitCode: EXIT_INVALID_INPUT,
      result: {
        ...base,
        exitCode: EXIT_INVALID_INPUT,
        workflowState: 'blocked',
        stopPoint: plan.expectedStopPoint === 'discovery' ? 'discovery' : 'enrichment',
      },
    };
  }

  const shortlistPath = args.continuation?.continuation.action.type === 'shortlist'
    ? args.continuation.declaredFilePath?.resolvedPath ?? null
    : null;

  console.log('  Executing stage: enrichment');
  if (resumableCurrent) console.log(`  Resuming enrichment: ${currentEnrichment.enrichmentId}`);
  const configured = await withEnrichmentCancellation(args.signal, () => args.deps.runConfiguredEnrichment({
    outputRoot,
    researchId: status.researchId,
    researchDirectory: status.researchDirectory,
    sourceRunId: status.discovery.runId,
    currentEnrichmentId: resumableCurrent ? currentEnrichment.enrichmentId : null,
    operatorConfig: provenance,
    shortlistPath,
    env: args.env,
    signal: args.signal,
  }));

  if (configured.outcome.kind !== 'completed') {
    return machineResultAfterEnrichment(base, provenance, configured);
  }
  if (provenance.semantics.workflow.target !== 'finalization') {
    return machineResultAfterEnrichment(base, provenance, configured);
  }

  // A completed enrichment changes the durable parent for finalization. Re-read
  // state and re-plan while still holding the same per-research execution lock.
  // The shortlist continuation was consumed by enrichment and must not be
  // reinterpreted as a finalization action.
  const refreshedStatus = await args.deps.buildStatus({ outputRoot, targetRunId: status.researchId });
  const finalizationContinuation = args.continuation?.continuation.action.type === 'shortlist'
    ? null
    : args.continuation;
  const refreshedPlan = args.deps.buildExistingPlan(refreshedStatus, finalizationContinuation, provenance);
  const refreshedBase = existingMachineResult(refreshedStatus, provenance, refreshedPlan);

  // A cancellation may arrive after the enrichment engine's final cancellation
  // check but before its durable completion/publication finishes. Honor that
  // request at the stage boundary without lying about the completed enrichment
  // or entering finalization/Common Crawl in the same process.
  if (args.signal.cancelled) {
    return {
      exitCode: EXIT_PAUSED,
      result: {
        ...refreshedBase,
        exitCode: EXIT_PAUSED,
        enrichmentId: configured.enrichmentId,
        enrichmentState: configured.outcome.state,
        workflowState: 'awaiting_finalization',
        stopPoint: 'finalization',
      },
    };
  }

  return advanceConfiguredFinalization(
    { ...args, continuation: finalizationContinuation },
    outputRoot,
    refreshedStatus,
    provenance,
    refreshedPlan,
    refreshedBase,
  );
}

async function advanceConfiguredFinalization(
  args: ContinueWorkflowArgs,
  outputRoot: string,
  status: ResearchStatusWithHistoricalPresence,
  provenance: PersistedOperatorConfigV1,
  plan: ExistingResearchExecutionPlan,
  base: ResearchRunMachineResultV1,
): Promise<ResearchRunExecution> {
  const finalizationStage = plan.stages.find((stage) => stage.id === 'finalization');
  if (!finalizationStage) throw new ResearchError('OUTPUT_WRITE_ERROR', 'Existing research plan omitted the finalization stage.');

  if (finalizationStage.state === 'not_requested') {
    return { exitCode: EXIT_OK, result: { ...base, workflowState: 'completed', stopPoint: 'complete' } };
  }
  if (finalizationStage.state === 'already_satisfied') {
    return {
      exitCode: EXIT_OK,
      result: {
        ...base,
        workflowState: 'completed',
        stopPoint: 'complete',
        finalizationState: 'published',
        unresolvedHumanRequirements: [],
      },
    };
  }
  if (plan.unresolvedHumanRequirements.includes('finalist_scope')) {
    console.log('  Stop point: configured finalization requires an explicit finalist scope.');
    console.log(`  Continue with: npm run research:run -- --research ${status.researchId} --continue <finalists-continuation.json>`);
    return {
      exitCode: EXIT_OK,
      result: {
        ...base,
        workflowState: 'awaiting_finalist_scope',
        stopPoint: 'finalization',
        unresolvedHumanRequirements: ['finalist_scope'],
      },
    };
  }
  if (plan.unresolvedHumanRequirements.includes('human_decisions')) {
    console.log('  Stop point: finalist evidence is current and requires explicit human decisions.');
    console.log(`  Continue with: npm run research:run -- --research ${status.researchId} --continue <decisions-continuation.json>`);
    return {
      exitCode: EXIT_OK,
      result: {
        ...base,
        workflowState: 'awaiting_decisions',
        stopPoint: 'finalization',
        finalizationState: 'awaiting_decisions',
        unresolvedHumanRequirements: ['human_decisions'],
      },
    };
  }
  if (finalizationStage.state !== 'ready') {
    return {
      exitCode: EXIT_INVALID_INPUT,
      result: {
        ...base,
        exitCode: EXIT_INVALID_INPUT,
        workflowState: 'blocked',
        stopPoint: 'finalization',
      },
    };
  }
  if (status.currentEnrichmentId === null) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', 'Ready finalization plan has no current enrichment id.');
  }

  console.log('  Executing stage: finalization');
  const configured = await args.deps.runConfiguredFinalization({
    outputRoot,
    researchId: status.researchId,
    researchDirectory: status.researchDirectory,
    enrichmentId: status.currentEnrichmentId,
    operatorConfig: provenance,
    continuation: args.continuation,
    status,
    env: args.env,
  });
  return machineResultAfterFinalization(base, configured);
}

function machineResultAfterFinalization(
  base: ResearchRunMachineResultV1,
  configured: ConfiguredFinalizationResult,
): ResearchRunExecution {
  if (configured.outcome.kind === 'awaiting_finalist_scope') {
    return {
      exitCode: EXIT_OK,
      result: {
        ...base,
        workflowState: 'awaiting_finalist_scope',
        stopPoint: 'finalization',
        finalizationState: 'not_started',
        publicationId: null,
        unresolvedHumanRequirements: ['finalist_scope'],
      },
    };
  }
  if (configured.outcome.kind === 'awaiting_decisions') {
    return {
      exitCode: EXIT_OK,
      result: {
        ...base,
        workflowState: 'awaiting_decisions',
        stopPoint: 'finalization',
        finalizationState: 'awaiting_decisions',
        publicationId: null,
        unresolvedHumanRequirements: ['human_decisions'],
      },
    };
  }
  if (
    base.finalizationState === 'awaiting_decisions'
    && configured.finalistEvidence === null
  ) {
    return {
      exitCode: EXIT_OK,
      result: {
        ...base,
        workflowState: 'awaiting_decisions',
        stopPoint: 'finalization',
        finalizationState: 'awaiting_decisions',
        publicationId: configured.outcome.publicationId,
        unresolvedHumanRequirements: ['human_decisions'],
      },
    };
  }
  return {
    exitCode: EXIT_OK,
    result: {
      ...base,
      workflowState: 'completed',
      stopPoint: 'complete',
      finalizationState: 'published',
      publicationId: configured.outcome.publicationId,
      unresolvedHumanRequirements: [],
    },
  };
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
    finalizationState: null,
    publicationId: null,
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
    finalizationState: status.finalization.state,
    publicationId: status.library.publicationId,
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

async function withEnrichmentCancellation<T>(
  signal: CancellationSignal,
  task: () => Promise<T>,
): Promise<T> {
  let sigintCount = 0;
  const onSigint = (): void => {
    sigintCount += 1;
    if (sigintCount === 1) {
      (signal as { cancelled: boolean }).cancelled = true;
      console.log('');
      console.log('Stopping enrichment gracefully... (Ctrl+C again to force quit)');
      return;
    }
    process.off('SIGINT', onSigint);
    process.kill(process.pid, 'SIGINT');
  };
  const onSigterm = (): void => {
    (signal as { cancelled: boolean }).cancelled = true;
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    return await task();
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
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
    'New research executes discovery and continues through configured stages until a human gate is reached.',
    'Existing research is always selected by explicit stable research id; generated discovery/enrichment ids are resolved from durable state.',
    'An unfinished configured discovery resumes from its persisted checkpoints when the same stable research id is run again.',
    'Shortlist, finalist scope, human decisions, traffic imports, representative overrides, and publication overrides use typed continuation files.',
    'No shortlist, finalist scope, human decision, or repair decision is invented automatically.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  process.exitCode = await runResearchRunCli(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();