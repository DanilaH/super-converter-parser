import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { PersistedOperatorConfigV1 } from './provenance.js';
import type { ResolvedOperatorContinuation } from './resolve.js';
import {
  buildExistingResearchPlan as buildCoreExistingResearchPlan,
  type ExistingResearchExecutionPlan,
} from './plannerCore.js';

export * from './plannerCore.js';

export function buildExistingResearchPlan(
  status: ResearchStatusWithHistoricalPresence,
  continuation: ResolvedOperatorContinuation | null,
  operatorConfig: PersistedOperatorConfigV1 | null = null,
): ExistingResearchExecutionPlan {
  let plan = buildCoreExistingResearchPlan(status, continuation, operatorConfig);
  if (isLibraryDerivedRepairReady(status, continuation, operatorConfig)) {
    plan = {
      ...plan,
      stages: plan.stages.map((stage) => stage.id === 'finalization'
        ? {
            id: 'finalization',
            state: 'ready',
            reason: 'Durable Library publication is current, but derived library.json/library.zip snapshots require idempotent repair.',
          }
        : stage),
      expectedStopPoint: 'finalization',
    };
  }

  if (!isConfiguredDiscoveryResumable(status, operatorConfig)) return plan;

  const discoveryStage = plan.stages.find((stage) => stage.id === 'discovery');
  if (!discoveryStage) return plan;
  const semantics = plan.semantics;
  if (semantics === null) return plan;

  return {
    ...plan,
    stages: plan.stages.map((stage) => stage.id === 'discovery'
      ? {
          id: 'discovery',
          state: 'ready',
          reason: `Current configured discovery is ${status.discovery.state}; resume its persisted keyword checkpoints using the stable research identity.`,
        }
      : stage),
    externalWork: [
      {
        stage: 'discovery',
        providers: [
          'google',
          'keyword_surfer',
          semantics.discovery.requireAhrefs ? 'ahrefs' : 'ahrefs_if_configured',
        ],
      },
      ...plan.externalWork.filter((work) => work.stage !== 'discovery'),
    ],
  };
}

function isLibraryDerivedRepairReady(
  status: ResearchStatusWithHistoricalPresence,
  continuation: ResolvedOperatorContinuation | null,
  operatorConfig: PersistedOperatorConfigV1 | null,
): boolean {
  return continuation === null
    && operatorConfig?.semantics.workflow.target === 'finalization'
    && status.finalization.state === 'published'
    && status.library.published
    && status.library.derivedSnapshotsCurrent === false;
}

function isConfiguredDiscoveryResumable(
  status: ResearchStatusWithHistoricalPresence,
  operatorConfig: PersistedOperatorConfigV1 | null,
): boolean {
  if (operatorConfig === null || status.discovery.keywordCounts.repairable > 0) return false;
  const discoveryOpen = status.discovery.keywordCounts.pending > 0 || status.discovery.keywordCounts.running > 0;
  return discoveryOpen && ['created', 'running', 'paused'].includes(status.discovery.state);
}
