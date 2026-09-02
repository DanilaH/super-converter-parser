import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';
import { buildExistingResearchPlan } from './planner.js';
import { buildPersistedOperatorConfig } from './provenance.js';
import {
  buildNewResearchPlan,
  type LoadedOperatorResearchConfig,
  type ResolvedOperatorContinuation,
} from './resolve.js';

function statusWithCurrentEnrichment(state: string | null): ResearchStatusWithHistoricalPresence {
  const enrichment = state === null
    ? null
    : {
        enrichmentId: 'enrich-1',
        generation: 1,
        directoryName: 'enrichment',
        sourceRunId: 'run-1',
        state,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        modules: ['query_suggestions'],
        itemCounts: {},
        error: null,
        isForCurrentDiscovery: true,
        isLatestForCurrentDiscovery: true,
      };
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
    enrichments: enrichment === null ? [] : [enrichment],
    currentEnrichmentId: enrichment?.enrichmentId ?? null,
    finalization: {
      state: 'not_started',
      enrichmentId: enrichment?.enrichmentId ?? null,
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
    nextAction: { code: enrichment === null ? 'run_enrichment' : 'resume_enrichment', message: 'Synthetic status.', command: null },
  };
}

function configured(target: 'discovery' | 'enrichment') {
  const config = {
    version: 1 as const,
    research: { label: 'configured', input: { type: 'seeds' as const, path: 'seeds.csv' } },
    workflow: { target },
    ...(target === 'enrichment' ? { enrichment: { modules: ['query_suggestions' as const] } } : {}),
  };
  const loaded = {
    config,
    plan: buildNewResearchPlan(config, '/tmp/research.config.json'),
  } as LoadedOperatorResearchConfig;
  return buildPersistedOperatorConfig(loaded);
}

function shortlistContinuation(): ResolvedOperatorContinuation {
  return {
    continuation: {
      version: 1,
      researchId: 'research-1',
      action: { type: 'shortlist', path: 'shortlist.csv' },
    },
    continuationPath: '/tmp/continuation.json',
    declaredFilePath: { logicalPath: 'shortlist.csv', resolvedPath: '/tmp/shortlist.csv' },
  };
}

test('shortlist continuation is rejected when persisted workflow does not request enrichment', () => {
  assert.throws(
    () => buildExistingResearchPlan(statusWithCurrentEnrichment(null), shortlistContinuation(), configured('discovery')),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /does not request enrichment/i.test(error.message),
  );
});

test('shortlist continuation is rejected after current enrichment is completed instead of becoming a no-op', () => {
  assert.throws(
    () => buildExistingResearchPlan(statusWithCurrentEnrichment('completed'), shortlistContinuation(), configured('enrichment')),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /cannot be applied.*completed/i.test(error.message),
  );
});

test('shortlist continuation remains valid for a resumable configured enrichment', () => {
  const plan = buildExistingResearchPlan(
    statusWithCurrentEnrichment('paused'),
    shortlistContinuation(),
    configured('enrichment'),
  );
  assert.equal(plan.stages[1]?.state, 'ready');
  assert.match(plan.stages[1]?.reason ?? '', /resume/i);
});
