import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';
import type { PersistedOperatorConfigV1, PortableResolvedResearchSemantics } from './provenance.js';
import type {
  ExternalWorkExpectation,
  NewResearchExecutionPlan,
  PlanStage,
  ResolvedOperatorContinuation,
  StageSemanticFingerprints,
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
  configAvailability: 'operator_config' | 'legacy_config_unavailable';
  configPath: null;
  effectiveConfigFingerprint: string | null;
  stageFingerprints: StageSemanticFingerprints | null;
  semantics: PortableResolvedResearchSemantics | null;
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
  operatorConfig: PersistedOperatorConfigV1 | null = null,
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
  const semantics = operatorConfig?.semantics ?? null;
  const target = semantics?.workflow.target ?? null;
  const wantsEnrichment = target === 'enrichment' || target === 'finalization';
  const wantsFinalization = target === 'finalization';
  const requiresShortlist = wantsEnrichment
    && semantics?.enrichment !== null
    && semantics?.enrichment !== undefined
    && semantics.enrichment.modules.some((module) => module !== 'clusters');
  const hasDurableEnrichmentWork = currentEnrichment !== null;
  const finalizationHasDurableState = status.finalization.state !== 'not_started';
  const finalizationRequested = operatorConfig === null || wantsFinalization || finalizationHasDurableState;
  const configuredEnrichmentResumable = currentEnrichment !== null
    && operatorConfig !== null
    && wantsEnrichment
    && ['created', 'paused', 'failed'].includes(currentEnrichment.state);
  const configuredFinalizationResumable = operatorConfig !== null
    && wantsFinalization
    && status.finalization.state === 'in_progress'
    && status.finalization.finalistCount > 0;

  const enrichmentStage: PlanStage = !discoverySatisfied
    ? { id: 'enrichment', state: 'blocked', reason: 'Requires current discovery to be complete and non-repairable.' }
    : enrichmentSatisfied
      ? { id: 'enrichment', state: 'already_satisfied', reason: null }
      : currentEnrichment !== null
        ? configuredEnrichmentResumable
          ? {
              id: 'enrichment',
              state: 'ready',
              reason: `Current configured enrichment is ${currentEnrichment.state}; resume it against its persisted discovery parent and config.`,
            }
          : {
              id: 'enrichment',
              state: 'blocked',
              reason: currentEnrichment.state === 'running'
                ? 'Current enrichment is running and may still be active; config-driven execution will not start a concurrent enrichment.'
                : `Current enrichment is ${currentEnrichment.state}; config-driven resume requires persisted OperatorConfig enrichment intent.`,
            }
        : operatorConfig === null
          ? { id: 'enrichment', state: 'blocked', reason: 'This existing research has no persisted OperatorConfig; downstream enrichment intent cannot be reconstructed safely.' }
          : !wantsEnrichment
            ? { id: 'enrichment', state: 'not_requested', reason: null }
            : requiresShortlist && action !== 'shortlist'
              ? { id: 'enrichment', state: 'blocked', reason: 'Configured enrichment requires an explicit shortlist continuation before execution.' }
              : {
                  id: 'enrichment',
                  state: 'ready',
                  reason: action === 'shortlist'
                    ? 'Configured enrichment is requested and an explicit shortlist continuation is supplied.'
                    : 'Configured enrichment is requested and current discovery satisfies its parent gate.',
                };

  const finalizationStage: PlanStage = !finalizationRequested
    ? { id: 'finalization', state: 'not_requested', reason: null }
    : !discoverySatisfied
      ? { id: 'finalization', state: 'blocked', reason: 'Requires current discovery to be complete and non-repairable.' }
      : !enrichmentSatisfied
        ? { id: 'finalization', state: 'blocked', reason: 'Requires a completed current enrichment.' }
        : finalizationSatisfied
          ? { id: 'finalization', state: 'already_satisfied', reason: null }
          : status.finalization.state === 'ready_to_publish'
            ? { id: 'finalization', state: 'ready', reason: 'Finalist evidence and human decisions are current; Library publication is the remaining accepted action.' }
            : readyContinuationReason !== null
              ? { id: 'finalization', state: 'ready', reason: readyContinuationReason }
              : configuredFinalizationResumable
                ? { id: 'finalization', state: 'ready', reason: 'Persisted finalist scope exists; resume config-driven finalization from current durable parent state.' }
                : { id: 'finalization', state: 'blocked', reason: finalizationBlockReason(status, operatorConfig !== null) };

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
    enrichmentStage,
    finalizationStage,
  ];

  const unresolvedHumanRequirements: ExistingResearchExecutionPlan['unresolvedHumanRequirements'] = [];
  if (operatorConfig === null) {
    if (discoverySatisfied && currentEnrichment === null) pushUnique(unresolvedHumanRequirements, 'operator_config');
    if (enrichmentSatisfied && (status.finalization.state === 'not_started' || status.finalization.state === 'in_progress')) {
      pushUnique(unresolvedHumanRequirements, 'operator_config');
    }
  }
  if (
    operatorConfig !== null
    && discoverySatisfied
    && currentEnrichment === null
    && wantsEnrichment
    && requiresShortlist
    && action !== 'shortlist'
  ) {
    pushUnique(unresolvedHumanRequirements, 'shortlist');
  }
  if (
    enrichmentSatisfied
    && finalizationRequested
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
    : operatorConfig !== null && !wantsEnrichment && !hasDurableEnrichmentWork
      ? 'complete'
      : !enrichmentSatisfied
        ? 'enrichment'
        : operatorConfig !== null && !wantsFinalization && !finalizationHasDurableState
          ? 'complete'
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
    configAvailability: operatorConfig === null ? 'legacy_config_unavailable' : 'operator_config',
    configPath: null,
    effectiveConfigFingerprint: operatorConfig?.effectiveConfigFingerprint ?? null,
    stageFingerprints: operatorConfig?.stageFingerprints ?? null,
    semantics,
    stages,
    externalWork: buildExistingExternalWork(semantics, enrichmentStage, finalizationStage, status, action),
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
    warnings: operatorConfig === null
      ? ['This research predates persisted OperatorConfig provenance. Planner will not infer downstream research intent from labels, latest-run order, or old CLI defaults.']
      : [],
  };
}

export function renderResearchPlan(plan: ResearchExecutionPlan): string {
  const lines = ['Research plan'];
  if (isExistingPlan(plan)) {
    lines.push(`  Target: existing research ${plan.stateContext.researchId}`);
    lines.push(`  Discovery: ${plan.stateContext.currentDiscoveryRunId}`);
    lines.push(`  Enrichment: ${plan.stateContext.currentEnrichmentId ?? 'none'}`);
    if (plan.configAvailability === 'operator_config' && plan.semantics !== null) {
      lines.push('  Operator config: persisted immutable provenance');
      lines.push(`  Workflow target: ${plan.semantics.workflow.target}`);
      lines.push(`  Market: ${plan.semantics.research.market} | Google hl/gl: ${plan.semantics.research.googleHl}/${plan.semantics.research.googleGl}`);
    } else {
      lines.push('  Operator config: unavailable for this legacy research');
    }
  } else {
    const semantics = plan.semantics;
    lines.push(`  Target: new research (${semantics.research.label})`);
    lines.push(`  Config: ${plan.configPath}`);
    lines.push(`  Workflow target: ${semantics.workflow.target}`);
    lines.push(`  Market: ${semantics.research.market} | Google hl/gl: ${semantics.research.googleHl}/${semantics.research.googleGl}`);
    lines.push(`  Input: ${semantics.research.input.type} ${semantics.research.input.logicalPath}`);
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
  if (isExistingPlan(plan)) {
    lines.push(`Durable next action: ${plan.durableState.nextAction.code} — ${plan.durableState.nextAction.message}`);
    if (plan.continuation) lines.push(`Continuation: ${plan.continuation.actionType} (${plan.continuation.sourcePath})`);
    for (const warning of plan.warnings) lines.push(`Warning: ${warning}`);
  }
  return `${lines.join('\n')}\n`;
}

function isExistingPlan(plan: ResearchExecutionPlan): plan is ExistingResearchExecutionPlan {
  return 'durableState' in plan;
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
    if (!status.finalization.finalistMatrixPublished) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        'A decisions continuation requires a current finalist evidence matrix; finish upstream finalization evidence first.',
      );
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
    return 'An explicit finalist scope continuation can advance the representative step.';
  }
  if (action === 'representative_overrides' && status.finalization.finalistCount > 0) {
    return 'Representative overrides can be applied to the persisted finalist scope; downstream evidence must then be rebuilt.';
  }
  if (action === 'traffic' && hasCurrentEntrantCohort(status)) {
    return 'Traffic evidence can be imported against the current entrant cohort; downstream finalist evidence must then be rebuilt.';
  }
  if (action === 'decisions' && status.finalization.state === 'awaiting_decisions') {
    return 'A decisions continuation is supplied for the current finalist scope; current human facts can be applied without rerunning upstream network evidence.';
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

function finalizationBlockReason(status: ResearchStatusWithHistoricalPresence, hasOperatorConfig: boolean): string {
  if (status.finalization.state === 'awaiting_decisions') {
    return `${status.finalization.currentDecisionCount}/${status.finalization.finalistCount} finalist(s) have current human decisions.`;
  }
  if (status.finalization.state === 'not_started') {
    return hasOperatorConfig
      ? 'Finalization is configured but has not started; an explicit finalist scope is required.'
      : 'Finalization has not started. This legacy research has no persisted OperatorConfig policy to reconstruct it safely.';
  }
  if (status.finalization.state === 'in_progress') {
    return hasOperatorConfig
      ? 'Finalization has partial durable state but no reusable finalist scope; supply an explicit finalist scope.'
      : 'Finalization is in progress, but this legacy research has no persisted OperatorConfig policy to resume it safely.';
  }
  if (status.finalization.state === 'ready_to_publish') return 'Finalization evidence is current; Library publication remains the accepted remaining action.';
  return `Finalization is ${status.finalization.state}.`;
}

function buildExistingExternalWork(
  semantics: PortableResolvedResearchSemantics | null,
  enrichmentStage: PlanStage,
  finalizationStage: PlanStage,
  status: ResearchStatusWithHistoricalPresence,
  action: ResolvedOperatorContinuation['continuation']['action']['type'] | null,
): ExternalWorkExpectation[] {
  if (semantics === null) return [];
  const work: ExternalWorkExpectation[] = [];
  if (enrichmentStage.state === 'ready' && semantics.enrichment !== null) {
    const providers = new Set<string>();
    if (semantics.enrichment.querySuggestions !== null) {
      if (semantics.enrichment.querySuggestions.sources.includes('surfer_related')) providers.add('keyword_surfer');
      if (semantics.enrichment.querySuggestions.sources.some((source) => source.startsWith('google_'))) providers.add('google');
    }
    if (semantics.enrichment.modules.includes('domain_age')) {
      providers.add('rdap');
      providers.add('first_seen_provider_if_configured');
    }
    if (semantics.enrichment.modules.includes('pages') || semantics.enrichment.modules.includes('site_structure')) providers.add('web_http');
    work.push({ stage: 'enrichment', providers: [...providers] });
  }
  if (finalizationStage.state === 'ready' && semantics.workflow.target === 'finalization') {
    const needsHistoricalNetwork = status.finalization.state === 'in_progress'
      || action === 'finalists'
      || action === 'finalists_all'
      || action === 'representative_overrides';
    if (needsHistoricalNetwork) work.push({ stage: 'finalization', providers: ['common_crawl'] });
  }
  return work;
}

function pushUnique<T>(items: T[], value: T): void {
  if (!items.includes(value)) items.push(value);
}
