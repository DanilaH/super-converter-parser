import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { OperatorResearchConfigV1 } from './contracts.js';
import { buildExistingResearchPlan } from './planner.js';
import { buildPersistedOperatorConfig } from './provenance.js';
import { buildNewResearchPlan, type ResolvedOperatorContinuation } from './resolve.js';

function provenance() {
  const config: OperatorResearchConfigV1 = {
    version: 1,
    research: { label: 'published-revision', input: { type: 'seeds', path: 'seeds.csv' } },
    workflow: { target: 'finalization' },
    enrichment: { modules: ['clusters'] },
    finalization: {
      historyPolicy: {
        youngDomainMaxAgeDays: 730,
        recentWebPresenceMaxAgeDays: 730,
        repurposeGapMinDays: 365,
      },
    },
  };
  return buildPersistedOperatorConfig({
    config,
    plan: buildNewResearchPlan(config, '/tmp/published-revision/research.config.json'),
  });
}

function publishedStatus(): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'published-revision',
    researchDirectory: '/tmp/output/research-1',
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
      pauseReason: null,
      keywordCounts: {
        total: 3,
        pending: 0,
        running: 0,
        completed: 3,
        partial: 0,
        failed: 0,
        repairable: 0,
      },
      qualityWarnings: [],
    },
    enrichments: [{
      enrichmentId: 'enrichment-1',
      generation: 1,
      directoryName: 'enrichment',
      sourceRunId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-01T00:00:02.000Z',
      updatedAt: '2026-09-01T00:00:03.000Z',
      modules: ['clusters'],
      itemCounts: {},
      error: null,
      isForCurrentDiscovery: true,
      isLatestForCurrentDiscovery: true,
    }],
    currentEnrichmentId: 'enrichment-1',
    finalization: {
      state: 'published',
      enrichmentId: 'enrichment-1',
      finalistCount: 2,
      currentDecisionCount: 2,
      allFinalistsHaveCurrentDecisions: true,
      finalistMatrixPublished: true,
      artifactWarning: null,
    },
    library: {
      published: true,
      publicationId: 'publication-1',
      publishedAt: '2026-09-01T00:00:04.000Z',
      reason: null,
      lookupError: null,
    },
    evidenceCoverage: {
      representativeUrlCoverage: { numerator: 2, denominator: 2, ratio: 1 },
      entrantDomainRows: 2,
      drKnownCoverage: { numerator: 2, denominator: 2, ratio: 1 },
      pageIdentityCoverage: { numerator: 2, denominator: 2, ratio: 1 },
      history: null,
      traffic: null,
      warnings: [],
    },
    nextAction: { code: 'none', message: 'complete', command: null },
    sampledHistoricalPresence: null,
  };
}

function continuation(
  action: ResolvedOperatorContinuation['continuation']['action'],
  resolvedPath: string | null = null,
): ResolvedOperatorContinuation {
  return {
    continuation: { version: 1, researchId: 'research-1', action } as ResolvedOperatorContinuation['continuation'],
    continuationPath: '/tmp/continuation.json',
    declaredFilePath: resolvedPath === null ? null : {
      logicalPath: resolvedPath.split('/').at(-1) ?? resolvedPath,
      resolvedPath,
    },
  };
}

test('published research without continuation remains already satisfied', () => {
  const plan = buildExistingResearchPlan(publishedStatus(), null, provenance());
  assert.equal(plan.stages.find((stage) => stage.id === 'finalization')?.state, 'already_satisfied');
  assert.equal(plan.expectedStopPoint, 'complete');
});

test('explicit traffic revision reopens a published finalization without declaring Common Crawl work', () => {
  const plan = buildExistingResearchPlan(
    publishedStatus(),
    continuation(
      { type: 'traffic', path: 'traffic.csv', lowBaseOrganicTrafficThreshold: 100 },
      '/tmp/traffic.csv',
    ),
    provenance(),
  );
  assert.equal(plan.stages.find((stage) => stage.id === 'finalization')?.state, 'ready');
  assert.equal(plan.expectedStopPoint, 'finalization');
  assert.equal(plan.externalWork.some((item) => item.stage === 'finalization' && item.providers.includes('common_crawl')), false);
});

test('explicit decisions revision reopens a published finalization', () => {
  const plan = buildExistingResearchPlan(
    publishedStatus(),
    continuation({ type: 'decisions', path: 'decisions.json' }, '/tmp/decisions.json'),
    provenance(),
  );
  assert.equal(plan.stages.find((stage) => stage.id === 'finalization')?.state, 'ready');
  assert.equal(plan.expectedStopPoint, 'finalization');
});
