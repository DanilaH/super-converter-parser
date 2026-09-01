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
  const finalizationSatisfied = status.finalization.state === 'published';
  const action = continuation?.continuation.action.type ?? null;
  const readyContinuationReason = finalizationContinuationReadyReason(status, action);

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
    !discoverySatisfied
      ? { id: 'finalization', state: 'blocked', reason: 'Requires current discovery to be complete and non-repairable.' }
      : !enrichmentSatisfied
        ? { id: 'finalization', state: 'blocked', reason: 'Requires a completed current enrichment.' }
        : finalizationSatisfied
          ? { id: 'finalization', state: 'already_satisfied', reason: null }
          : status.finalization.state === 'ready_to_publish'
            ? { id: 'finalization', state: 'ready', reason: 'Finalist evidence and human decisions are current; Library publication is the remaining accepted action.' }
            : readyContinuationReason !== null
              ? { id: 'finalization', state: 'ready', reason: readyContinuationReason }
              : { id: 'finalization', state: 'blocked', reason: finalizationBlockReason(status) },
  ];

  const unresolvedHumanRequirements: ExistingResearchExecutionPlan['unresolvedHumanRequirements'] = [];
  if (discoverySatisfied && currentEnrichment === null) pushUnique(unresolvedHumanRequirements, 'operator_config');
  if (enrichmentSatisfied && (status.finalization.state === 'not_started' || status.finalization.state === 'in_progress')) {
    pushUnique(unresolvedHumanRequirements, 'operator_config');
  }
  if (
    enrichmentSatisfied
    && status.finalization.state === 'not_started'
    && action !== 'finalists'
    && action !== 'finalists_all'
  ) {
    pushUnique(unresolvedHumanRequirements, 'finalist_scope');
  }
  if (
    status.finalization.state === 'awaiting_decisions'
    && action !== 'decisions'
    && action !== 'publication_override'
  ) {
    pushUnique(unresolvedHumanRequirements, 'human_decisions');
  }

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
  if (plan.configAvailability === 'operator_config') {
    const semantics = plan.semantics;
    lines.push(`  Target: new research (${semantics.research.label})`);
    lines.push(`  Config: ${plan.configPath}`);
    lines.push(`  Workflow target: ${semantics.workflow.target}`);
    lines.push(`  Market: ${semantics.research.market} | Google hl/gl: ${semantics.research.googleHl}/${semantics.research.googleGl}`);
    lines.push(`  Input: ${semantics.research.input.type} ${semantics.research.input.logicalPath}`);
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
  if (plan.configAvailability === 'legacy_config_unavailable') {
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

  if (action === 'finalists' || action === 'finalists_all') return;
  if (action === 'representative_overrides' && status.finalization.finalistCount === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Representative overrides require an existing current finalist scope.');
  }
  if (action === 'traffic' && !hasCurrentEntrantCohort(status)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'A traffic continuation requires a current entrant cohort.');
  }
  if (action === 'decisions') {
    if (status.finalization.finalistCount === 0) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', 'A decisions continuation requires an existing current finalist scope.');
    }
    if (!hasCurrentEntrantCohort(status)) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', 'A decisions continuation requires a current entrant cohort.');
    }
  }
  if (action === 'publication_override' && !status.finalization.finalistMatrixPublished) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'A publication override requires a current finalist evidence matrix.');
  }
}

function finalizationContinuationReadyReason(
  status: ResearchStatusWithHistoricalPresence,
  action: ResolvedOperatorContinuation['continuation']['action']['type'] | null,
): string | null {
  if (action === 'finalists' || action === 'finalists_all') {
    return 'An explicit finalist scope continuation can advance the representative step; missing legacy OperatorConfig policy remains visible separately.';
  }
  if (action === 'representative_overrides' && status.finalization.finalistCount > 0) {
    return 'Representative overrides can be applied to the persisted finalist scope; downstream evidence must then be rebuilt.';
  }
  if (action === 'traffic' && hasCurrentEntrantCohort(status)) {
    return 'Traffic evidence can be imported against the current entrant cohort; downstream finalist evidence must then be rebuilt.';
  }
  if (action === 'decisions' && status.finalization.state === 'awaiting_decisions') {
    return 'A decisions continuation is supplied for the current finalist scope; execution remains a later PR.';
  }
  if (action === 'publication_override' && status.finalization.finalistMatrixPublished && !status.library.published) {
    return 'An explicit incomplete-publication override is supplied against the current finalist evidence matrix.';
  }
  return null;
}

function hasCurrentEntrantCohort(status: ResearchStatusWithHistoricalPresence): boolean {
  if (
    status.finalization.state === 'awaiting_decisions'
    || status.finalization.state === 'ready_to_publish'
    || status.finalization.state === 'published'
  ) {
    return true;
  }
  if (status.finalization.finalistCount === 0 || status.evidenceCoverage === null) return false;
  return !status.evidenceCoverage.warnings.some((warning) => warning.code === 'ENTRANT_COHORT_NOT_COLLECTED');
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

function pushUnique<T>(items: T[], value: T): void {
  if (!items.includes(value)) items.push(value);
}
