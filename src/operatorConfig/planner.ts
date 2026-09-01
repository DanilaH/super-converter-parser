import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';
import type {
  ExternalWorkExpectation,
  NewResearchExecutionPlan,
  PlanStage,
  ResolvedOperatorContinuation,
} from './resolve.js';

export type ExistingResearchExecutionPlan = {
  version: 1;
  stateContext: {
    kind: 'existing';
    researchId: string;
    currentDiscoveryRunId: string;
    currentEnrichmentId: string | null;
    legacyLayout: boolean;
  };
  configAvailability: 'legacy_config_unavailable';
  configPath: null;
  effectiveConfigFingerprint: null;
  stageFingerprints: null;
  semantics: null;
  stages: PlanStage[];
  externalWork: ExternalWorkExpectation[];
  filesystemInputs: Array<{ purpose: 'continuation_input'; logicalPath: string; resolvedPath: string }>;
  unresolvedHumanRequirements: Array<'operator_config' | 'shortlist' | 'finalist_scope' | 'human_decisions'>;
  expectedStopPoint: 'discovery' | 'enrichment' | 'finalization' | 'complete';
  continuation: null | {
    actionType: string;
    sourcePath: string;
    declaredFilePath: { logicalPath: string; resolvedPath: string } | null;
  };
  durableState: {
    discoveryState: string;
    repairableDiscoveryCheckpoints: number;
    enrichmentState: string | null;
    finalizationState: string;
    finalistCount: number;
    currentDecisionCount: number;
    libraryPublished: boolean;
    nextAction: { code: string; message: string };
  };
  warnings: string[];
};

export type ResearchExecutionPlan = NewResearchExecutionPlan | ExistingResearchExecutionPlan;

export function buildExistingResearchPlan(
  status: ResearchStatusWithHistoricalPresence,
  continuation: ResolvedOperatorContinuation | null,
): ExistingResearchExecutionPlan {
  if (continuation !== null && continuation.continuation.researchId !== status.researchId) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Continuation targets research "${continuation.continuation.researchId}" but --research resolved to "${status.researchId}".`,
    );
  }

  validateContinuationAgainstDurableState(status, continuation);

  const discoveryTerminal = status.discovery.state === 'completed' || status.discovery.state === 'completed_with_errors';
  const discoveryOpen = status.discovery.keywordCounts.pending > 0 || status.discovery.keywordCounts.running > 0;
  const discoverySatisfied = discoveryTerminal && !discoveryOpen && status.discovery.keywordCounts.repairable === 0;
  const currentEnrichment = status.currentEnrichmentId === null
    ? null
    : status.enrichments.find((item) => item.enrichmentId === status.currentEnrichmentId) ?? null;
  const enrichmentSatisfied = currentEnrichment?.state === 'completed';
  const finalizationSatisfied = status.finalization.state === 'ready_to_publish' || status.finalization.state === 'published';

  const stages: PlanStage[] = [
    discoverySatisfied
      ? { id: 'discovery', state: 'already_satisfied', reason: null }
      : {
          id: 'discovery',
          state: 'blocked',
          reason: status.discovery.keywordCounts.repairable > 0
            ? `${status.discovery.keywordCounts.repairable} discovery checkpoint(s) are repairable before downstream work.`
            : `Discovery is ${status.discovery.state}; finish or resume it before downstream work.`,
        },
    !discoverySatisfied
      ? { id: 'enrichment', state: 'blocked', reason: 'Requires current discovery to be complete and non-repairable.' }
      : enrichmentSatisfied
        ? { id: 'enrichment', state: 'already_satisfied', reason: null }
        : currentEnrichment !== null
          ? { id: 'enrichment', state: 'blocked', reason: `Current enrichment is ${currentEnrichment.state}; resume it through the accepted legacy path.` }
          : { id: 'enrichment', state: 'blocked', reason: 'This existing research has no persisted OperatorConfig; downstream enrichment intent cannot be reconstructed safely.' },
    !enrichmentSatisfied
      ? { id: 'finalization', state: 'blocked', reason: 'Requires a completed current enrichment.' }
      : finalizationSatisfied
        ? { id: 'finalization', state: 'already_satisfied', reason: null }
        : status.finalization.state === 'awaiting_decisions' && continuation?.continuation.action.type === 'decisions'
          ? { id: 'finalization', state: 'ready', reason: 'A decisions continuation is supplied for the current finalist scope; execution remains a later PR.' }
          : { id: 'finalization', state: 'blocked', reason: finalizationBlockReason(status) },
  ];

  const unresolvedHumanRequirements: ExistingResearchExecutionPlan['unresolvedHumanRequirements'] = [];
  if (currentEnrichment === null && discoverySatisfied) unresolvedHumanRequirements.push('operator_config');
  if (status.finalization.state === 'not_started' && enrichmentSatisfied) unresolvedHumanRequirements.push('finalist_scope');
  if (status.finalization.state === 'awaiting_decisions' && continuation?.continuation.action.type !== 'decisions') unresolvedHumanRequirements.push('human_decisions');

  const expectedStopPoint: ExistingResearchExecutionPlan['expectedStopPoint'] = !discoverySatisfied
    ? 'discovery'
    : !enrichmentSatisfied
      ? 'enrichment'
      : status.finalization.state === 'published'
        ? 'complete'
        : 'finalization';

  return {
    version: 1,
    stateContext: {
      kind: 'existing',
      researchId: status.researchId,
      currentDiscoveryRunId: status.discovery.runId,
      currentEnrichmentId: status.currentEnrichmentId,
      legacyLayout: status.legacy,
    },
    configAvailability: 'legacy_config_unavailable',
    configPath: null,
    effectiveConfigFingerprint: null,
    stageFingerprints: null,
    semantics: null,
    stages,
    externalWork: [],
    filesystemInputs: continuation?.declaredFilePath
      ? [{ purpose: 'continuation_input', ...continuation.declaredFilePath }]
      : [],
    unresolvedHumanRequirements,
    expectedStopPoint,
    continuation: continuation === null ? null : {
      actionType: continuation.continuation.action.type,
      sourcePath: continuation.continuationPath,
      declaredFilePath: continuation.declaredFilePath,
    },
    durableState: {
      discoveryState: status.discovery.state,
      repairableDiscoveryCheckpoints: status.discovery.keywordCounts.repairable,
      enrichmentState: currentEnrichment?.state ?? null,
      finalizationState: status.finalization.state,
      finalistCount: status.finalization.finalistCount,
      currentDecisionCount: status.finalization.currentDecisionCount,
      libraryPublished: status.library.published,
      nextAction: { code: status.nextAction.code, message: status.nextAction.message },
    },
    warnings: [
      'This research predates persisted OperatorConfig provenance. Planner will not infer downstream research intent from labels, latest-run order, or old CLI defaults.',
    ],
  };
}

export function renderResearchPlan(plan: ResearchExecutionPlan): string {
  const lines = ['Research plan'];
  if (plan.stateContext.kind === 'new') {
    lines.push(`  Target: new research (${plan.semantics.research.label})`);
    lines.push(`  Config: ${plan.configPath}`);
    lines.push(`  Workflow target: ${plan.semantics.workflow.target}`);
    lines.push(`  Market: ${plan.semantics.research.market} | Google hl/gl: ${plan.semantics.research.googleHl}/${plan.semantics.research.googleGl}`);
    lines.push(`  Input: ${plan.semantics.research.input.type} ${plan.semantics.research.input.logicalPath}`);
  } else {
    lines.push(`  Target: existing research ${plan.stateContext.researchId}`);
    lines.push(`  Discovery: ${plan.stateContext.currentDiscoveryRunId}`);
    lines.push(`  Enrichment: ${plan.stateContext.currentEnrichmentId ?? 'none'}`);
    lines.push('  Operator config: unavailable for this legacy research');
  }

  lines.push('', 'Stages');
  for (const stage of plan.stages) {
    lines.push(`  ${stage.id}: ${stage.state}${stage.reason ? ` — ${stage.reason}` : ''}`);
  }

  lines.push('', 'External/network work');
  if (plan.externalWork.length === 0 || plan.externalWork.every((item) => item.providers.length === 0)) {
    lines.push('  none declared by this plan');
  } else {
    for (const item of plan.externalWork) lines.push(`  ${item.stage}: ${item.providers.length > 0 ? item.providers.join(', ') : 'none'}`);
  }

  lines.push('', 'Filesystem inputs');
  if (plan.filesystemInputs.length === 0) lines.push('  none');
  else for (const input of plan.filesystemInputs) lines.push(`  ${input.purpose}: ${input.logicalPath} -> ${input.resolvedPath}`);

  lines.push('', 'Unresolved operator requirements');
  if (plan.unresolvedHumanRequirements.length === 0) lines.push('  none');
  else for (const requirement of plan.unresolvedHumanRequirements) lines.push(`  - ${requirement}`);

  lines.push('', `Expected stop point: ${plan.expectedStopPoint}`);
  if (plan.stateContext.kind === 'existing') {
    lines.push(`Durable next action: ${plan.durableState.nextAction.code} — ${plan.durableState.nextAction.message}`);
    if (plan.continuation) lines.push(`Continuation: ${plan.continuation.actionType} (${plan.continuation.sourcePath})`);
    for (const warning of plan.warnings) lines.push(`Warning: ${warning}`);
  }
  return `${lines.join('\n')}\n`;
}

function validateContinuationAgainstDurableState(
  status: ResearchStatusWithHistoricalPresence,
  continuation: ResolvedOperatorContinuation | null,
): void {
  if (continuation === null) return;
  const action = continuation.continuation.action.type;
  const discoveryTerminal = status.discovery.state === 'completed' || status.discovery.state === 'completed_with_errors';
  const discoveryOpen = status.discovery.keywordCounts.pending > 0 || status.discovery.keywordCounts.running > 0;
  if (!discoveryTerminal || discoveryOpen) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Continuation action "${action}" cannot be planned while discovery is ${status.discovery.state}.`);
  }
  if (action === 'shortlist') return;
  const currentEnrichment = status.currentEnrichmentId === null
    ? null
    : status.enrichments.find((item) => item.enrichmentId === status.currentEnrichmentId) ?? null;
  if (currentEnrichment?.state !== 'completed') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Continuation action "${action}" requires a completed current enrichment.`);
  }
  if (action === 'decisions' && status.finalization.finalistCount === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'A decisions continuation requires an existing current finalist scope.');
  }
  if (action === 'publication_override' && !status.finalization.finalistMatrixPublished) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'A publication override requires a current finalist evidence matrix.');
  }
}

function finalizationBlockReason(status: ResearchStatusWithHistoricalPresence): string {
  if (status.finalization.state === 'awaiting_decisions') {
    return `${status.finalization.currentDecisionCount}/${status.finalization.finalistCount} finalist(s) have current human decisions.`;
  }
  if (status.finalization.state === 'not_started') {
    return 'Finalization has not started. This legacy research has no persisted OperatorConfig policy to reconstruct it safely.';
  }
  if (status.finalization.state === 'in_progress') return 'Finalization is in progress; continue through the accepted legacy path until config-first execution is implemented.';
  if (status.finalization.state === 'ready_to_publish') return 'Finalization evidence is current; Library publication remains a separate accepted action.';
  return `Finalization is ${status.finalization.state}.`;
}
