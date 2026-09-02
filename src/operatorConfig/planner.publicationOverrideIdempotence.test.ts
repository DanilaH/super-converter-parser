import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { buildExistingResearchPlan } from './planner.js';
import { buildPersistedOperatorConfig } from './provenance.js';
import {
  buildNewResearchPlan,
  type LoadedOperatorResearchConfig,
  type ResolvedOperatorContinuation,
} from './resolve.js';

function configuredFinalization() {
  const config = {
    version: 1 as const,
    research: { label: 'configured', input: { type: 'seeds' as const, path: 'seeds.csv' } },
    workflow: { target: 'finalization' as const },
    enrichment: { modules: ['clusters' as const] },
    finalization: {
      historyPolicy: {
        youngDomainMaxAgeDays: 730,
        recentWebPresenceMaxAgeDays: 1095,
        repurposeGapMinDays: 365,
      },
    },
  };
  const loaded = {
    config,
    plan: buildNewResearchPlan(config, '/tmp/research.config.json'),
  } as LoadedOperatorResearchConfig;
  return buildPersistedOperatorConfig(loaded);
}

function overrideContinuation(): ResolvedOperatorContinuation {
  return {
    continuation: {
      version: 1,
      researchId: 'research-1',
      action: { type: 'publication_override', publishWithoutDecisions: true },
    },
    continuationPath: '/tmp/publication-override.json',
    declaredFilePath: null,
  };
}

function alreadyOverridePublishedStatus(): ResearchStatusWithHistoricalPresence {
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
      state: 'completed',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      modules: ['clusters'],
      itemCounts: {},
      error: null,
      isForCurrentDiscovery: true,
      isLatestForCurrentDiscovery: true,
    }],
    currentEnrichmentId: 'enrich-1',
    finalization: {
      state: 'awaiting_decisions',
      enrichmentId: 'enrich-1',
      finalistCount: 2,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: true,
      artifactWarning: null,
    },
    library: {
      published: true,
      publicationId: 'publication-1',
      publishedAt: '2026-01-02',
      reason: null,
      lookupError: null,
    },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: { code: 'supply_decisions', message: 'Human decisions remain optional after override publication.', command: null },
  };
}

test('repeating an already-published publication override remains an actionable idempotent continuation', () => {
  const plan = buildExistingResearchPlan(
    alreadyOverridePublishedStatus(),
    overrideContinuation(),
    configuredFinalization(),
  );
  assert.equal(plan.stages[2]?.state, 'ready');
  assert.match(plan.stages[2]?.reason ?? '', /override/i);
  assert.deepEqual(plan.unresolvedHumanRequirements, []);
  assert.equal(plan.expectedStopPoint, 'finalization');
});
