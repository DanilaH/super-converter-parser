import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { ResolvedOperatorContinuation } from './resolve.js';
import { buildExistingResearchPlan, renderResearchPlan } from './planner.js';
import { ResearchError } from '../shared/errors.js';

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

function continuation(action: ResolvedOperatorContinuation['continuation']['action'], researchId = 'research-1'): ResolvedOperatorContinuation {
  return { continuation: { version: 1, researchId, action } as ResolvedOperatorContinuation['continuation'], continuationPath: '/tmp/continue.json', declaredFilePath: 'path' in action ? { logicalPath: action.path, resolvedPath: `/tmp/${action.path}` } : null };
}

test('existing research planner refuses mismatched continuation research id', () => {
  assert.throws(() => buildExistingResearchPlan(status(), continuation({ type: 'shortlist', path: 'shortlist.csv' }, 'other')), (error: unknown) => error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR');
});

test('legacy existing research does not invent missing operator config', () => {
  const plan = buildExistingResearchPlan(status(), null);
  assert.equal(plan.configAvailability, 'legacy_config_unavailable');
  assert.deepEqual(plan.stages.map((item) => [item.id, item.state]), [['discovery', 'already_satisfied'], ['enrichment', 'blocked'], ['finalization', 'blocked']]);
  assert.deepEqual(plan.unresolvedHumanRequirements, ['operator_config']);
  assert.match(renderResearchPlan(plan), /will not infer downstream research intent/i);
});

test('decisions continuation becomes ready only for current completed enrichment with finalists', () => {
  const currentEnrichment = { enrichmentId: 'enrich-1', generation: 1, directoryName: 'enrichment', sourceRunId: 'run-1', state: 'completed', createdAt: 'x', updatedAt: 'x', modules: ['clusters'], itemCounts: {}, error: null, isForCurrentDiscovery: true, isLatestForCurrentDiscovery: true };
  const current = status({
    enrichments: [currentEnrichment], currentEnrichmentId: 'enrich-1',
    finalization: { state: 'awaiting_decisions', enrichmentId: 'enrich-1', finalistCount: 2, currentDecisionCount: 0, allFinalistsHaveCurrentDecisions: false, finalistMatrixPublished: true, artifactWarning: null },
    nextAction: { code: 'supply_decisions', message: 'Supply decisions.', command: null },
  });
  const plan = buildExistingResearchPlan(current, continuation({ type: 'decisions', path: 'decisions.json' }));
  assert.equal(plan.stages[2]?.state, 'ready');
  assert.deepEqual(plan.unresolvedHumanRequirements, []);
});

test('continuations fail closed against incompatible durable state', () => {
  assert.throws(() => buildExistingResearchPlan(status(), continuation({ type: 'decisions', path: 'decisions.json' })), /requires a completed current enrichment/);
  const paused = status({ discovery: { ...status().discovery, state: 'paused', keywordCounts: { ...status().discovery.keywordCounts, pending: 1 } } });
  assert.throws(() => buildExistingResearchPlan(paused, continuation({ type: 'shortlist', path: 'shortlist.csv' })), /while discovery is paused/);
});
