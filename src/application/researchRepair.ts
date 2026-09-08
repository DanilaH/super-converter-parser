import process from 'node:process';
import { runDiscovery, type CliDeps, type DiscoveryRunResult } from '../discovery/runDiscovery.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { acquireResearchExecutionLock } from '../operatorConfig/executionLock.js';
import { buildResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';
import { DEFAULT_CLI_DEPS } from '../discovery/runDiscovery.js';

export type ResearchDiscoveryRepairResultV1 = {
  version: 1;
  researchId: string;
  discoveryRunId: string;
  exitCode: number;
  discoveryState: string | null;
  repairableBefore: number;
  repairableAfter: number;
};

export type ResearchDiscoveryRepairDeps = {
  buildStatus: typeof buildResearchStatusWithHistoricalPresence;
  acquireExecutionLock: typeof acquireResearchExecutionLock;
  runDiscovery: typeof runDiscovery;
  cliDeps: CliDeps;
};

export const DEFAULT_RESEARCH_DISCOVERY_REPAIR_DEPS: ResearchDiscoveryRepairDeps = {
  buildStatus: buildResearchStatusWithHistoricalPresence,
  acquireExecutionLock: acquireResearchExecutionLock,
  runDiscovery,
  cliDeps: DEFAULT_CLI_DEPS,
};

export type ResearchDiscoveryRepairOptions = {
  outputRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  deps?: ResearchDiscoveryRepairDeps;
};

/**
 * Explicitly repair failed/provably-incomplete primary discovery checkpoints.
 *
 * This is deliberately separate from config-first continuation. The canonical
 * status projection must identify repair_discovery both before and after the
 * per-research execution lock is acquired; no repair decision is inferred from
 * a generic failed/partial count.
 */
export async function repairResearchDiscovery(
  researchId: string,
  options: ResearchDiscoveryRepairOptions = {},
): Promise<ResearchDiscoveryRepairResultV1> {
  const normalizedId = researchId.trim();
  if (normalizedId === '') throw new ResearchError('INPUT_SCHEMA_ERROR', 'Research id is required for discovery repair.');

  const env = options.env ?? process.env;
  const deps = options.deps ?? DEFAULT_RESEARCH_DISCOVERY_REPAIR_DEPS;
  const outputRoot = resolveOutputRoot(options.outputRoot ?? null, env);
  const initial = await deps.buildStatus({ outputRoot, targetRunId: normalizedId });
  assertRepairable(initial);

  const release = await deps.acquireExecutionLock(outputRoot, initial.researchId);
  try {
    const locked = await deps.buildStatus({ outputRoot, targetRunId: initial.researchId });
    assertRepairable(locked);
    if (locked.discovery.runId !== initial.discovery.runId) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Current discovery changed from ${initial.discovery.runId} to ${locked.discovery.runId} before repair could start. Re-open the research and review the current state.`,
      );
    }

    const repairableBefore = locked.discovery.keywordCounts.repairable;
    const repaired = await deps.runDiscovery(
      {
        input: { kind: 'resume', runId: locked.discovery.runId },
        retryFailed: true,
        outputRoot,
        manageProcessSignals: false,
      },
      deps.cliDeps,
      env,
    );
    const after = await deps.buildStatus({ outputRoot, targetRunId: locked.researchId });
    return repairResult(locked, repaired, after, repairableBefore);
  } finally {
    await release();
  }
}

function assertRepairable(status: ResearchStatusWithHistoricalPresence): void {
  const repairable = status.discovery.keywordCounts.repairable;
  if (status.nextAction.code !== 'repair_discovery' || repairable <= 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${status.researchId} is not currently eligible for explicit discovery repair. Canonical next action is ${status.nextAction.code}; repairable checkpoints: ${repairable}.`,
    );
  }
}

function repairResult(
  before: ResearchStatusWithHistoricalPresence,
  repaired: DiscoveryRunResult,
  after: ResearchStatusWithHistoricalPresence,
  repairableBefore: number,
): ResearchDiscoveryRepairResultV1 {
  if (after.researchId !== before.researchId || after.discovery.runId !== before.discovery.runId) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      'Discovery repair changed stable research/discovery identity unexpectedly.',
    );
  }
  return {
    version: 1,
    researchId: before.researchId,
    discoveryRunId: before.discovery.runId,
    exitCode: repaired.exitCode,
    discoveryState: repaired.state ?? after.discovery.state,
    repairableBefore,
    repairableAfter: after.discovery.keywordCounts.repairable,
  };
}
