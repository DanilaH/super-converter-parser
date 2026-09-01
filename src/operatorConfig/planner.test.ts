import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';
import { buildPersistedOperatorConfig } from './provenance.js';
import { buildNewResearchPlan, type LoadedOperatorResearchConfig, type ResolvedOperatorContinuation } from './resolve.js';
import { buildExistingResearchPlan, renderResearchPlan } from './planner.js';

function status(overrides: Partial<ResearchStatusWithHistoricalPresence> = {}): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0', researchId: 'research-1', label: 'legacy', researchDirectory: '/tmp/research', legacy: false,
    discovery: { generation: 1, runId: 'run-1', state: 'completed', createdAt: '2026-01-01', updatedAt: '2026-01-01', pauseReason: null, keywordCounts: { total: 2, pending: 0, running: 0, completed: 2, partial: 0, failed: 0, repairable: 0 }, qualityWarnings: [] },
    enrichments: [], currentEnrichmentId: null,
    finalization: { state: 'not_started', enrichmentId: null, finalistCount: 0, currentDecisionCount: 0, allFinalistsHaveCurrentDecisions: false, finalistMatrixPublished: false, artifactWarning: null },
    library: { published: false, publicationId: null, publishedAt: null, reason: 'no_current_enrichment', lookupError: null },
    evidenceCoverage: null, sampledHistoricalPresence: null,
    nextAction: { code: 'run_enrichment', message: 'No enrichment exists for the current discovery generation.', command: 'legacy command' },
    ...overrides,
  };
}

function completedEnrichment() {
  return { enrichmentId: 'enrich-1', generation: 1, directoryName: 'enrichment', sourceRunId: 'run-1', state: 'completed', createdAt: 'x', updatedAt: 'x', modules: ['clusters'], itemCounts: {}, error: null, isForCurrentDiscovery: true, isLatestForCurrentDiscovery: true };
}

function continuation(action: ResolvedOperatorContinuation['continuation']['action'], researchId = 'research-1'): ResolvedOperatorContinuation {
  return { continuation: { version: 1, researchId, action } as ResolvedOperatorContinuation['continuation'], continuationPath: '/tmp/continue.json', declaredFilePath: 'path' in action ? { logicalPath: action.path, resolvedPath: `/tmp/${action.path}` } : null };
}

function entrantCoverage(present: boolean): NonNullable<ResearchStatusWithHistoricalPresence['evidenceCoverage']> {
  return {
    representativeUrlCoverage: null,
    entrantDomainRows: present ? 1 : 0,
    drKnownCoverage: null,
    pageIdentityCoverage: null,
    history: null,
    traffic: null,
    warnings: present ? [] : [{ code: 'ENTRANT_COHORT_NOT_COLLECTED', affectedCount: 1, denominator: 1, message: 'missing' }],
  };
}

function configured(target: 'discovery' | 'enrichment' | 'finalization', modules: Array<'clusters' | 'query_suggestions'> = ['clusters']) {
  const config = {
    version: 1 as const,
    research: { label: 'configured', input: { type: 'seeds' as const, path: 'seeds.csv' } },
    workflow: { target },
    ...(target === 'discovery' ? {} : { enrichment: { modules } }),
    ...(target === 'finalization'
      ? { finalization: { historyPolicy: { youngDomainMaxAgeDays: 730, recentWebPresenceMaxAgeDays: 1095, repurposeGapMinDays: 365 } } }
      : {}),
  };
  const loaded = { config, plan: buildNewResearchPlan(config, '/tmp/research.config.json') } as LoadedOperatorResearchConfig;
  return buildPersistedOperatorConfig(loaded);
}

test('existing research planner refuses mismatched continuation research id', () => {
  assert.throws(() => buildExistingResearchPlan(status(), continuation({ type: 'shortlist', path: 'shortlist.csv' }, 'other')), (error: unknown) => error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR');
});

test('legacy existing research does not invent missing operator config or premature finalist gates', () => {
  const plan = buildExistingResearchPlan(status(), null);
  assert.equal(plan.configAvailability, 'legacy_config_unavailable');
  assert.deepEqual(plan.stages.map((item) => [item.id, item.state]), [['discovery', 'already_satisfied'], ['enrichment', 'blocked'], ['finalization', 'blocked']]);
  assert.deepEqual(plan.unresolvedHumanRequirements, ['operator_config']);
  assert.match(renderResearchPlan(plan), /will not infer downstream research intent/i);
});

test('persisted discovery-only config marks the workflow complete after discovery', () => {
  const plan = buildExistingResearchPlan(status(), null, configured('discovery'));
  assert.equal(plan.configAvailability, 'operator_config');
  assert.deepEqual(plan.stages.map((item) => [item.id, item.state]), [['discovery', 'already_satisfied'], ['enrichment', 'not_requested'], ['finalization', 'not_requested']]);
  assert.deepEqual(plan.unresolvedHumanRequirements, []);
  assert.equal(plan.expectedStopPoint, 'complete');
  assert.match(renderResearchPlan(plan), /persisted immutable provenance/i);
});

test('persisted enrichment config becomes ready without reconstructing flags', () => {
  const plan = buildExistingResearchPlan(status(), null, configured('enrichment'));
  assert.equal(plan.stages[1]?.state, 'ready');
  assert.equal(plan.stages[2]?.state, 'not_requested');
  assert.equal(plan.expectedStopPoint, 'enrichment');
  assert.deepEqual(plan.unresolvedHumanRequirements, []);
});

test('configured enrichment that needs non-cluster evidence remains blocked on explicit shortlist', () => {
  const persisted = configured('enrichment', ['clusters', 'query_suggestions']);
  const blocked = buildExistingResearchPlan(status(), null, persisted);
  assert.equal(blocked.stages[1]?.state, 'blocked');
  assert.deepEqual(blocked.unresolvedHumanRequirements, ['shortlist']);

  const supplied = buildExistingResearchPlan(status(), continuation({ type: 'shortlist', path: 'shortlist.csv' }), persisted);
  assert.equal(supplied.stages[1]?.state, 'ready');
  assert.deepEqual(supplied.unresolvedHumanRequirements, []);
});

test('completed enrichment exposes the finalist gate without inventing finalization policy for legacy research', () => {
  const current = status({
    enrichments: [completedEnrichment()], currentEnrichmentId: 'enrich-1',
    finalization: { state: 'not_started', enrichmentId: 'enrich-1', finalistCount: 0, currentDecisionCount: 0, allFinalistsHaveCurrentDecisions: false, finalistMatrixPublished: false, artifactWarning: null },
  });
  const plan = buildExistingResearchPlan(current, null);
  assert.deepEqual(plan.unresolvedHumanRequirements, ['operator_config', 'finalist_scope']);
});

test('configured finalization exposes finalist scope after completed enrichment without an operator-config blocker', () => {
  const current = status({
    enrichments: [completedEnrichment()], currentEnrichmentId: 'enrich-1',
    finalization: { state: 'not_started', enrichmentId: 'enrich-1', finalistCount: 0, currentDecisionCount: 0, allFinalistsHaveCurrentDecisions: false, finalistMatrixPublished: false, artifactWarning: null },
  });
  const plan = buildExistingResearchPlan(current, null, configured('finalization'));
  assert.deepEqual(plan.unresolvedHumanRequirements, ['finalist_scope']);
  assert.equal(plan.stages[2]?.state, 'blocked');
  const supplied = buildExistingResearchPlan(current, continuation({ type: 'finalists_all' }), configured('finalization'));
  assert.equal(supplied.stages[2]?.state, 'ready');
  assert.deepEqual(supplied.unresolvedHumanRequirements, []);
});

test('explicit finalist scope can advance one legacy finalization step without pretending config is recovered', () => {
  const current = status({
    enrichments: [completedEnrichment()], currentEnrichmentId: 'enrich-1',
    finalization: { state: 'not_started', enrichmentId: 'enrich-1', finalistCount: 0, currentDecisionCount: 0, allFinalistsHaveCurrentDecisions: false, finalistMatrixPublished: false, artifactWarning: null },
  });
  const plan = buildExistingResearchPlan(current, continuation({ type: 'finalists', clusters: ['cluster-1', 'cluster-2'] }));
  assert.equal(plan.stages[2]?.state, 'ready');
  assert.deepEqual(plan.unresolvedHumanRequirements, ['operator_config']);
});

test('decisions continuation becomes ready only for current completed enrichment with finalists', () => {
  const current = status({
    enrichments: [completedEnrichment()], currentEnrichmentId: 'enrich-1',
    finalization: { state: 'awaiting_decisions', enrichmentId: 'enrich-1', finalistCount: 2, currentDecisionCount: 0, allFinalistsHaveCurrentDecisions: false, finalistMatrixPublished: true, artifactWarning: null },
    nextAction: { code: 'supply_decisions', message: 'Supply decisions.', command: null },
  });
  const plan = buildExistingResearchPlan(current, continuation({ type: 'decisions', path: 'decisions.json' }));
  assert.equal(plan.stages[2]?.state, 'ready');
  assert.deepEqual(plan.unresolvedHumanRequirements, []);
});

test('repairable discovery blocks finalization even when downstream durable state and decisions exist', () => {
  const current = status({
    discovery: { ...status().discovery, state: 'completed_with_errors', keywordCounts: { ...status().discovery.keywordCounts, failed: 1, repairable: 1 } },
    enrichments: [completedEnrichment()], currentEnrichmentId: 'enrich-1',
    finalization: { state: 'awaiting_decisions', enrichmentId: 'enrich-1', finalistCount: 2, currentDecisionCount: 0, allFinalistsHaveCurrentDecisions: false, finalistMatrixPublished: true, artifactWarning: null },
  });
  const plan = buildExistingResearchPlan(current, continuation({ type: 'decisions', path: 'decisions.json' }));
  assert.deepEqual(plan.stages.map((item) => [item.id, item.state]), [['discovery', 'blocked'], ['enrichment', 'blocked'], ['finalization', 'blocked']]);
  assert.equal(plan.expectedStopPoint, 'discovery');
});

test('traffic continuation requires a current entrant cohort and becomes ready when one exists', () => {
  const base = status({
    enrichments: [completedEnrichment()], currentEnrichmentId: 'enrich-1',
    finalization: { state: 'in_progress', enrichmentId: 'enrich-1', finalistCount: 2, currentDecisionCount: 0, allFinalistsHaveCurrentDecisions: false, finalistMatrixPublished: false, artifactWarning: null },
    evidenceCoverage: entrantCoverage(false),
  });
  assert.throws(
    () => buildExistingResearchPlan(base, continuation({ type: 'traffic', path: 'traffic.csv', lowBaseOrganicTrafficThreshold: 1000 })),
    /requires a current entrant cohort/,
  );
  const withEntrant = buildExistingResearchPlan(
    status({ ...base, evidenceCoverage: entrantCoverage(true) }),
    continuation({ type: 'traffic', path: 'traffic.csv', lowBaseOrganicTrafficThreshold: 1000 }),
  );
  assert.equal(withEntrant.stages[2]?.state, 'ready');
  assert.ok(withEntrant.unresolvedHumanRequirements.includes('operator_config'));
});

test('ready-to-publish evidence remains actionable until the Library snapshot is published', () => {
  const current = status({
    enrichments: [completedEnrichment()], currentEnrichmentId: 'enrich-1',
    finalization: { state: 'ready_to_publish', enrichmentId: 'enrich-1', finalistCount: 2, currentDecisionCount: 2, allFinalistsHaveCurrentDecisions: true, finalistMatrixPublished: true, artifactWarning: null },
    library: { published: false, publicationId: null, publishedAt: null, reason: 'not_published', lookupError: null },
    nextAction: { code: 'publish_library', message: 'Publish Library snapshot.', command: 'npm run library:publish -- --enrichment enrich-1' },
  });
  const plan = buildExistingResearchPlan(current, null);
  assert.equal(plan.stages[2]?.state, 'ready');
  assert.equal(plan.expectedStopPoint, 'finalization');
  assert.equal(plan.durableState.nextAction.code, 'publish_library');
});

test('published research is the only fully satisfied finalization state', () => {
  const current = status({
    enrichments: [completedEnrichment()], currentEnrichmentId: 'enrich-1',
    finalization: { state: 'published', enrichmentId: 'enrich-1', finalistCount: 2, currentDecisionCount: 2, allFinalistsHaveCurrentDecisions: true, finalistMatrixPublished: true, artifactWarning: null },
    library: { published: true, publicationId: 'publication-1', publishedAt: '2026-01-02', reason: null, lookupError: null },
    nextAction: { code: 'none', message: 'Complete.', command: null },
  });
  const plan = buildExistingResearchPlan(current, null);
  assert.equal(plan.stages[2]?.state, 'already_satisfied');
  assert.equal(plan.expectedStopPoint, 'complete');
});

test('publication override deliberately resolves the human-decision gate without fabricating decisions', () => {
  const current = status({
    enrichments: [completedEnrichment()], currentEnrichmentId: 'enrich-1',
    finalization: { state: 'awaiting_decisions', enrichmentId: 'enrich-1', finalistCount: 2, currentDecisionCount: 0, allFinalistsHaveCurrentDecisions: false, finalistMatrixPublished: true, artifactWarning: null },
  });
  const plan = buildExistingResearchPlan(current, continuation({ type: 'publication_override', publishWithoutDecisions: true }));
  assert.equal(plan.stages[2]?.state, 'ready');
  assert.deepEqual(plan.unresolvedHumanRequirements, []);
  assert.equal(plan.durableState.currentDecisionCount, 0);
});

test('continuations fail closed against incompatible durable state', () => {
  assert.throws(() => buildExistingResearchPlan(status(), continuation({ type: 'decisions', path: 'decisions.json' })), /requires a completed current enrichment/);
  const paused = status({ discovery: { ...status().discovery, state: 'paused', keywordCounts: { ...status().discovery.keywordCounts, pending: 1 } } });
  assert.throws(() => buildExistingResearchPlan(paused, continuation({ type: 'shortlist', path: 'shortlist.csv' })), /while discovery is paused/);
  const noScope = status({ enrichments: [completedEnrichment()], currentEnrichmentId: 'enrich-1' });
  assert.throws(() => buildExistingResearchPlan(noScope, continuation({ type: 'representative_overrides', path: 'reps.json' })), /existing current finalist scope/);
});
