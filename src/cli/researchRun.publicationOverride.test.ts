import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfiguredFinalizationResult } from '../finalization/configuredRun.js';
import type { OperatorResearchConfigV1 } from '../operatorConfig/contracts.js';
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan } from '../operatorConfig/resolve.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  runResearchFromExisting,
  type ResearchRunDeps,
} from './researchRun.js';

function provenance() {
  const config: OperatorResearchConfigV1 = {
    version: 1,
    research: { label: 'publication-override', input: { type: 'seeds', path: 'seeds.csv' } },
    workflow: { target: 'finalization' },
    enrichment: { modules: ['clusters'] },
    finalization: {
      representativeCount: 5,
      historyPolicy: {
        youngDomainMaxAgeDays: 730,
        recentWebPresenceMaxAgeDays: 730,
        repurposeGapMinDays: 365,
      },
    },
  };
  return buildPersistedOperatorConfig({
    config,
    plan: buildNewResearchPlan(config, '/tmp/publication-override/research.config.json'),
  });
}

function status(): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'publication-override',
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
      state: 'awaiting_decisions',
      enrichmentId: 'enrichment-1',
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
      reason: 'decisions_incomplete',
      lookupError: null,
    },
    evidenceCoverage: null,
    nextAction: { code: 'supply_decisions', message: 'supply decisions', command: null },
    sampledHistoricalPresence: null,
  };
}

function deps(result: ConfiguredFinalizationResult): ResearchRunDeps {
  return {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    buildStatus: async () => status(),
    loadProvenance: async () => provenance(),
    loadContinuation: async () => ({
      continuation: {
        version: 1,
        researchId: 'research-1',
        action: { type: 'publication_override', publishWithoutDecisions: true },
      },
      continuationPath: '/tmp/publication-override.json',
      declaredFilePath: null,
    }),
    acquireExecutionLock: async () => async () => undefined,
    runConfiguredEnrichment: async () => { throw new Error('enrichment is already complete'); },
    runConfiguredFinalization: async () => result,
  };
}

test('incomplete publication override publishes the snapshot without claiming human finalization is complete', async () => {
  const result: ConfiguredFinalizationResult = {
    outcome: { kind: 'published', state: 'published', publicationId: 'publication-override-1' },
    fullRun: null,
    traffic: null,
    finalistEvidence: null,
    publication: {
      publicationId: 'publication-override-1',
      changed: true,
      supersedesPublicationId: null,
      publicationCount: 1,
      libraryDbPath: '/tmp/library.sqlite',
      libraryJsonPath: '/tmp/library.json',
      libraryArchivePath: '/tmp/library.zip',
    },
  };

  const execution = await runResearchFromExisting(
    'research-1',
    '/tmp/publication-override.json',
    '/tmp/output',
    deps(result),
    {} as NodeJS.ProcessEnv,
  );

  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.workflowState, 'awaiting_decisions');
  assert.equal(execution.result.stopPoint, 'finalization');
  assert.equal(execution.result.finalizationState, 'awaiting_decisions');
  assert.equal(execution.result.publicationId, 'publication-override-1');
  assert.deepEqual(execution.result.unresolvedHumanRequirements, ['human_decisions']);
});
