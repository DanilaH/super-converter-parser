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

function interruptedRepresentativeInvalidationStatus(): ResearchStatusWithHistoricalPresence {
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
      // A representative snapshot revision was durably changed. SQLite has
      // already invalidated the entrant parent, so status is in_progress, but
      // the process crashed before old finalist artifacts were removed from
      // manifest.json. The stale artifact bit must not authorize publication.
      state: 'in_progress',
      enrichmentId: 'enrich-1',
      finalistCount: 2,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: true,
      artifactWarning: null,
    },
    library: {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: 'current_snapshot_not_published',
      lookupError: null,
    },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: { code: 'run_finalization', message: 'Resume finalization.', command: null },
  };
}

test('publication override cannot bypass an in-progress stale-parent finalization state', () => {
  assert.throws(
    () => buildExistingResearchPlan(
      interruptedRepresentativeInvalidationStatus(),
      overrideContinuation(),
      configuredFinalization(),
    ),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /current finalist evidence matrix/i.test(error.message),
  );
});
