import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { buildExistingResearchPlan } from './planner.js';
import type { ResolvedOperatorContinuation } from './resolve.js';

function statusBeforeMatrix(): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'planner-finalization-decisions',
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
      state: 'in_progress',
      enrichmentId: 'enrichment-1',
      finalistCount: 1,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: null,
    },
    library: {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: null,
      lookupError: null,
    },
    evidenceCoverage: {
      warnings: [],
    } as ResearchStatusWithHistoricalPresence['evidenceCoverage'],
    nextAction: { code: 'run_finalization', message: 'continue finalization', command: null },
    sampledHistoricalPresence: null,
  };
}

const decisionsContinuation: ResolvedOperatorContinuation = {
  continuation: {
    version: 1,
    researchId: 'research-1',
    action: { type: 'decisions', path: 'decisions.json' },
  },
  continuationPath: '/tmp/decisions-continuation.json',
  declaredFilePath: {
    logicalPath: 'decisions.json',
    resolvedPath: '/tmp/decisions.json',
  },
};

test('planner rejects human decisions before a current finalist evidence matrix exists', () => {
  assert.throws(
    () => buildExistingResearchPlan(statusBeforeMatrix(), decisionsContinuation, null),
    /requires a current finalist evidence matrix/,
  );
});
