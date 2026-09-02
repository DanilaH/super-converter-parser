import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { loadCohortHistoricalPresenceState } from '../db/cohortHistoricalPresence.js';
import {
  projectSampledHistoricalPresenceCoverage,
  type SampledHistoricalPresenceCoverage,
} from '../historicalPresence/evidenceProjection.js';
import { inspectResearchLibraryDerivedSnapshots } from '../library/derivedSnapshotHealth.js';
import { buildExistingResearchPlan, type ExistingResearchExecutionPlan } from '../operatorConfig/planner.js';
import { readOperatorConfigProvenance } from '../operatorConfig/provenance.js';
import { buildResearchStatus, type ResearchNextAction, type ResearchStatus } from './status.js';

export type ResearchStatusWithHistoricalPresence = Omit<ResearchStatus, 'version' | 'library'> & {
  version: '1.2.0';
  library: ResearchStatus['library'] & {
    derivedSnapshotsCurrent?: boolean | null;
    derivedSnapshotWarning?: string | null;
  };
  sampledHistoricalPresence: SampledHistoricalPresenceCoverage | null;
};

export async function buildResearchStatusWithHistoricalPresence(input: {
  outputRoot: string;
  targetRunId: string;
}): Promise<ResearchStatusWithHistoricalPresence> {
  const base = await buildResearchStatus(input);
  let sampledHistoricalPresence: SampledHistoricalPresenceCoverage | null = null;

  if (!base.legacy && base.currentEnrichmentId !== null) {
    const enrichment = base.enrichments.find(
      (item) => item.enrichmentId === base.currentEnrichmentId && item.isLatestForCurrentDiscovery,
    );
    if (!enrichment) {
      throw new Error(`Current enrichment ${base.currentEnrichmentId} is missing from the read-only status projection.`);
    }

    const store = RunStore.openReadOnly(
      join(base.researchDirectory, enrichment.directoryName, 'enrichment.sqlite'),
    );
    try {
      const entrant = loadEntrantCohortState(store, enrichment.enrichmentId);
      const state = loadCohortHistoricalPresenceState(store, enrichment.enrichmentId);
      sampledHistoricalPresence = projectSampledHistoricalPresenceCoverage({
        cohorts: entrant?.cohorts ?? null,
        state,
      });
    } finally {
      store.close();
    }
  }

  const derivedHealth = !base.legacy && base.library.published
    ? await inspectResearchLibraryDerivedSnapshots(input.outputRoot)
    : null;
  const projected: ResearchStatusWithHistoricalPresence = {
    ...base,
    version: '1.2.0',
    library: {
      ...base.library,
      derivedSnapshotsCurrent: derivedHealth?.current ?? null,
      derivedSnapshotWarning: derivedHealth?.warning ?? null,
    },
    sampledHistoricalPresence,
  };
  if (projected.legacy) return projected;

  const provenance = await readOperatorConfigProvenance(projected.researchDirectory);
  if (provenance === null) return projected;
  const plan = buildExistingResearchPlan(projected, null, provenance);
  return { ...projected, nextAction: configFirstNextAction(plan) };
}

function configFirstNextAction(plan: ExistingResearchExecutionPlan): ResearchNextAction {
  const researchId = plan.stateContext.researchId;
  const stableRunCommand = `npm run research:run -- --research ${researchId}`;
  const discovery = requireStage(plan, 'discovery');
  const enrichment = requireStage(plan, 'enrichment');
  const finalization = requireStage(plan, 'finalization');

  if (plan.durableState.repairableDiscoveryCheckpoints > 0) {
    return {
      code: 'repair_discovery',
      message: `${plan.durableState.repairableDiscoveryCheckpoints} discovery checkpoint(s) require an explicit specialist repair decision before configured downstream work can continue.`,
      command: `npm run research -- --resume ${plan.stateContext.currentDiscoveryRunId} --retry-failed`,
    };
  }
  if (discovery.state === 'ready') {
    return {
      code: 'resume_discovery',
      message: 'Configured discovery has resumable persisted checkpoints; continue it using the stable research id.',
      command: stableRunCommand,
    };
  }
  if (discovery.state === 'blocked') {
    return {
      code: 'resume_discovery',
      message: discovery.reason ?? 'Configured discovery is blocked and cannot continue automatically.',
      command: null,
    };
  }

  if (plan.unresolvedHumanRequirements.includes('shortlist')) {
    return {
      code: 'run_enrichment',
      message: 'Configured enrichment requires an explicit shortlist continuation for this research.',
      command: null,
    };
  }
  if (enrichment.state === 'ready') {
    const resuming = plan.durableState.enrichmentState !== null;
    return {
      code: resuming ? 'resume_enrichment' : 'run_enrichment',
      message: resuming
        ? `Configured enrichment is ${plan.durableState.enrichmentState}; resume it using the stable research id.`
        : 'Configured enrichment is ready for the current completed discovery.',
      command: stableRunCommand,
    };
  }
  if (enrichment.state === 'blocked' && plan.expectedStopPoint === 'enrichment') {
    return {
      code: 'resume_enrichment',
      message: enrichment.reason ?? 'Configured enrichment is blocked.',
      command: null,
    };
  }

  if (plan.unresolvedHumanRequirements.includes('finalist_scope')) {
    return {
      code: 'run_finalization',
      message: 'Configured finalization requires an explicit finalist-scope continuation for this research.',
      command: null,
    };
  }
  if (plan.unresolvedHumanRequirements.includes('human_decisions')) {
    return {
      code: 'supply_decisions',
      message: `${plan.durableState.currentDecisionCount}/${plan.durableState.finalistCount} finalist(s) have current human decisions; supply an explicit decisions continuation.`,
      command: null,
    };
  }
  if (finalization.state === 'ready') {
    if (plan.durableState.finalizationState === 'published' && plan.durableState.libraryPublished) {
      return {
        code: 'publish_library',
        message: 'Durable Library publication exists, but derived library.json/library.zip snapshots need idempotent repair.',
        command: stableRunCommand,
      };
    }
    if (plan.durableState.finalizationState === 'ready_to_publish') {
      return {
        code: 'publish_library',
        message: 'Configured finalization evidence and human decisions are current; publish the current Library snapshot through the config-first workflow.',
        command: stableRunCommand,
      };
    }
    return {
      code: 'run_finalization',
      message: finalization.reason ?? 'Configured finalization is ready to continue.',
      command: stableRunCommand,
    };
  }
  if (finalization.state === 'blocked' && plan.expectedStopPoint === 'finalization') {
    return {
      code: 'run_finalization',
      message: finalization.reason ?? 'Configured finalization is blocked.',
      command: null,
    };
  }

  return {
    code: 'none',
    message: 'All stages requested by the persisted OperatorConfig are complete.',
    command: null,
  };
}

function requireStage(
  plan: ExistingResearchExecutionPlan,
  id: 'discovery' | 'enrichment' | 'finalization',
): ExistingResearchExecutionPlan['stages'][number] {
  const stage = plan.stages.find((item) => item.id === id);
  if (!stage) throw new Error(`Existing research plan omitted ${id} stage.`);
  return stage;
}
