import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import {
  runConfiguredFinalization,
  type ConfiguredFinalizationDeps,
} from './configuredRun.js';

const status = {
  version: '1.2.0',
  researchId: 'research-1',
  label: 'library-repair',
  researchDirectory: '/tmp/output/research-1',
  legacy: false,
  discovery: {
    generation: 1,
    runId: 'research-1',
    state: 'completed',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:01.000Z',
    pauseReason: null,
    keywordCounts: { total: 5, pending: 0, running: 0, completed: 5, partial: 0, failed: 0, repairable: 0 },
    qualityWarnings: [],
  },
  enrichments: [{
    enrichmentId: 'enrichment-1',
    generation: 1,
    directoryName: 'enrichment',
    sourceRunId: 'research-1',
    state: 'completed',
    createdAt: '2026-09-02T00:00:02.000Z',
    updatedAt: '2026-09-02T00:00:03.000Z',
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
    finalistCount: 1,
    currentDecisionCount: 1,
    allFinalistsHaveCurrentDecisions: true,
    finalistMatrixPublished: true,
    artifactWarning: null,
  },
  library: {
    published: true,
    publicationId: 'pub-current',
    publishedAt: '2026-09-02T00:00:04.000Z',
    reason: null,
    lookupError: null,
    derivedSnapshotsCurrent: false,
    derivedSnapshotWarning: 'library.zip is stale',
  },
  evidenceCoverage: null,
  nextAction: { code: 'publish_library', message: 'repair', command: null },
  sampledHistoricalPresence: null,
} as ResearchStatusWithHistoricalPresence;

const operatorConfig = {
  semantics: {
    workflow: { target: 'finalization' },
    finalization: {},
  },
} as unknown as PersistedOperatorConfigV1;

test('configured finalization repairs derived Library snapshots without rerunning evidence', async () => {
  let publications = 0;
  let evidenceRuns = 0;
  const deps: ConfiguredFinalizationDeps = {
    runFullFinalization: async () => {
      evidenceRuns += 1;
      throw new Error('full finalization must not rerun');
    },
    runTrafficEvidence: async () => {
      evidenceRuns += 1;
      throw new Error('traffic must not rerun');
    },
    runFinalistEvidence: async () => {
      evidenceRuns += 1;
      throw new Error('finalist evidence must not rerun');
    },
    runLibraryPublication: async () => {
      publications += 1;
      return {
        publicationId: 'pub-current',
        changed: false,
        supersedesPublicationId: null,
        publicationCount: 1,
        libraryDbPath: '/tmp/output/research-library/library.sqlite',
        libraryJsonPath: '/tmp/output/research-library/library.json',
        libraryArchivePath: '/tmp/output/research-library/library.zip',
      };
    },
  };

  const result = await runConfiguredFinalization({
    outputRoot: '/tmp/output',
    researchId: 'research-1',
    researchDirectory: '/tmp/output/research-1',
    enrichmentId: 'enrichment-1',
    operatorConfig,
    continuation: null,
    status,
    env: {} as NodeJS.ProcessEnv,
    logger: () => undefined,
  }, deps);

  assert.equal(result.outcome.kind, 'published');
  assert.equal(result.outcome.kind === 'published' ? result.outcome.publicationId : null, 'pub-current');
  assert.equal(publications, 1);
  assert.equal(evidenceRuns, 0);
  assert.equal(result.fullRun, null);
  assert.equal(result.finalistEvidence, null);
});
