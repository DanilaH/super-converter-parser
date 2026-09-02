import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { buildExistingResearchPlan } from './planner.js';
import { buildPersistedOperatorConfig } from './provenance.js';
import { buildNewResearchPlan, type LoadedOperatorResearchConfig } from './resolve.js';

function configuredEnrichment() {
  const config = {
    version: 1 as const,
    research: { label: 'configured', input: { type: 'seeds' as const, path: 'seeds.csv' } },
    workflow: { target: 'enrichment' as const },
    enrichment: { modules: ['clusters' as const] },
  };
  const loaded = {
    config,
    plan: buildNewResearchPlan(config, '/tmp/research.config.json'),
  } as LoadedOperatorResearchConfig;
  return buildPersistedOperatorConfig(loaded);
}

function statusWithEnrichment(
  state: ResearchStatusWithHistoricalPresence['enrichments'][number]['state'],
): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'configured',
    researchDirectory: '/tmp/research',
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'run-1',
      state: 'completed',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      pauseReason: null,
      keywordCounts: { total: 2, pending: 0, running: 0, completed: 2, partial: 0, failed: 0, repairable: 0 },
      qualityWarnings: [],
    },
    enrichments: [{
      enrichmentId: 'enrich-1',
      generation: 1,
      directoryName: 'enrichment',
      sourceRunId: 'run-1',
      state,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      modules: ['clusters'],
      itemCounts: {},
      error: state === 'failed' ? 'synthetic failure' : null,
      isForCurrentDiscovery: true,
      isLatestForCurrentDiscovery: true,
    }],
    currentEnrichmentId: 'enrich-1',
    finalization: {
      state: 'not_started',
      enrichmentId: 'enrich-1',
      finalistCount: 0,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: null,
    },
    library: {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: 'not_published',
      lookupError: null,
    },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: { code: 'resume_enrichment', message: 'Resume current enrichment.', command: null },
  };
}

for (const state of ['created', 'paused', 'failed', 'running'] as const) {
  test(`configured ${state} enrichment is resumable through the stable research plan`, () => {
    const plan = buildExistingResearchPlan(statusWithEnrichment(state), null, configuredEnrichment());
    assert.equal(plan.stages[0]?.state, 'already_satisfied');
    assert.equal(plan.stages[1]?.state, 'ready');
    assert.match(plan.stages[1]?.reason ?? '', /resume/i);
    assert.equal(plan.expectedStopPoint, 'enrichment');
    assert.equal(plan.durableState.enrichmentState, state);
    assert.deepEqual(plan.unresolvedHumanRequirements, []);
  });
}
