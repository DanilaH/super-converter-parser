import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan, type ResolvedOperatorContinuation } from '../operatorConfig/resolve.js';
import type { OperatorResearchConfigV1 } from '../operatorConfig/contracts.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { FinalistEvidenceRunResult } from './finalistEvidenceRun.js';
import type { FullFinalizationRunRequest, FullFinalizationRunResult } from './fullFinalizationRun.js';
import type { LibraryPublicationRunResult } from './libraryPublicationRun.js';
import type { TrafficEvidenceRunResult } from './trafficEvidenceRun.js';
import {
  runConfiguredFinalization,
  type ConfiguredFinalizationDeps,
} from './configuredRun.js';

function operatorConfig(): PersistedOperatorConfigV1 {
  const config: OperatorResearchConfigV1 = {
    version: 1,
    research: { label: 'configured-finalization', input: { type: 'seeds', path: 'seeds.csv' } },
    workflow: { target: 'finalization' },
    enrichment: { modules: ['clusters'] },
    finalization: {
      representativeCount: 7,
      historyPolicy: {
        youngDomainMaxAgeDays: 701,
        recentWebPresenceMaxAgeDays: 702,
        repurposeGapMinDays: 303,
      },
      historicalPresence: {
        collectionMode: 'latest',
        recentMonths: 11,
        maxCollections: 13,
        domainCap: 17,
      },
    },
  };
  return buildPersistedOperatorConfig({
    config,
    plan: buildNewResearchPlan(config, '/tmp/configured-finalization/research.config.json'),
  });
}

function status(
  finalizationState: ResearchStatusWithHistoricalPresence['finalization']['state'],
  options: { finalistCount?: number; currentDecisionCount?: number; matrix?: boolean } = {},
): ResearchStatusWithHistoricalPresence {
  const finalistCount = options.finalistCount ?? 0;
  const currentDecisionCount = options.currentDecisionCount ?? 0;
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'configured-finalization',
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
        total: 5,
        pending: 0,
        running: 0,
        completed: 5,
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
      state: finalizationState,
      enrichmentId: 'enrichment-1',
      finalistCount,
      currentDecisionCount,
      allFinalistsHaveCurrentDecisions: finalistCount > 0 && currentDecisionCount === finalistCount,
      finalistMatrixPublished: options.matrix ?? finalizationState === 'awaiting_decisions' || finalizationState === 'ready_to_publish',
      artifactWarning: null,
    },
    library: {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: null,
      lookupError: null,
    },
    evidenceCoverage: null,
    nextAction: { code: 'run_finalization', message: 'continue finalization', command: null },
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
    declaredFilePath: resolvedPath === null ? null : { logicalPath: resolvedPath.split('/').at(-1) ?? resolvedPath, resolvedPath },
  };
}

function publication(): LibraryPublicationRunResult {
  return {
    publicationId: 'publication-1',
    changed: true,
    supersedesPublicationId: null,
    publicationCount: 1,
    libraryDbPath: '/tmp/library.sqlite',
    libraryJsonPath: '/tmp/library.json',
    libraryArchivePath: '/tmp/library.zip',
  };
}

function finalist(current: number, total: number): FinalistEvidenceRunResult {
  return {
    enrichmentId: 'enrichment-1',
    sourceRunId: 'research-1',
    representativeRevision: 2,
    entrantFingerprint: 'entrant-fp',
    finalistCount: total,
    cohortHistoryAvailableCount: total,
    sampledHistoryCollectedCount: total,
    importedTrafficSnapshotCount: 0,
    currentHumanDecisionCount: current,
    staleHumanDecisionCount: 0,
    unrecordedHumanDecisionCount: total - current,
    auditFlagCount: total - current,
    csvPath: '/tmp/finalists.csv',
    jsonPath: '/tmp/finalists.json',
  };
}

function traffic(): TrafficEvidenceRunResult {
  return {
    enrichmentId: 'enrichment-1',
    sourceRunId: 'research-1',
    changed: true,
    importedSnapshotCount: 1,
    currentTargetSnapshotCount: 1,
    matchedSnapshotCount: 1,
    mismatchedSnapshotCount: 0,
    staleTargetSnapshotCount: 0,
    historyCount: 1,
    velocityCount: 0,
    lowBaseWarningCount: 0,
    trafficValueCurrencyMismatchCount: 0,
    inserted: 1,
    duplicates: 0,
    policy: { lowBaseOrganicTrafficThreshold: 100 },
    evidencePath: '/tmp/traffic.csv',
    velocityPath: '/tmp/velocity.csv',
    jsonPath: '/tmp/traffic.json',
  };
}

function baseRequest(
  currentStatus: ResearchStatusWithHistoricalPresence,
  currentContinuation: ResolvedOperatorContinuation | null,
) {
  return {
    outputRoot: '/tmp/output',
    researchId: 'research-1',
    researchDirectory: '/tmp/output/research-1',
    enrichmentId: 'enrichment-1',
    operatorConfig: operatorConfig(),
    continuation: currentContinuation,
    status: currentStatus,
    env: {} as NodeJS.ProcessEnv,
    logger: () => undefined,
  };
}

function deps(overrides: Partial<ConfiguredFinalizationDeps>): ConfiguredFinalizationDeps {
  return {
    runFullFinalization: async () => { throw new Error('unexpected full finalization'); },
    runTrafficEvidence: async () => { throw new Error('unexpected traffic'); },
    runFinalistEvidence: async () => { throw new Error('unexpected finalist evidence'); },
    runLibraryPublication: async () => { throw new Error('unexpected publication'); },
    ...overrides,
  };
}

test('configured finalization stops before side effects when finalist scope is missing', async () => {
  const result = await runConfiguredFinalization(
    baseRequest(status('not_started'), null),
    deps({}),
  );
  assert.equal(result.outcome.kind, 'awaiting_finalist_scope');
});

test('explicit finalist scope maps immutable OperatorConfig policy into the shared full-finalization service', async () => {
  const observed: FullFinalizationRunRequest[] = [];
  const result = await runConfiguredFinalization(
    baseRequest(
      status('not_started'),
      continuation({ type: 'finalists', clusters: ['cluster-7', 'cluster-9'] }),
    ),
    deps({
      runFullFinalization: async (request) => {
        observed.push(request);
        return {
          state: 'awaiting_decisions',
          finalistEvidence: finalist(0, 2),
          traffic: null,
          publication: null,
        } as unknown as FullFinalizationRunResult;
      },
    }),
  );

  assert.equal(result.outcome.kind, 'awaiting_decisions');
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0]?.selectedClusterIds, ['cluster-7', 'cluster-9']);
  assert.equal(observed[0]?.allClusters, false);
  assert.equal(observed[0]?.representativeCount, 7);
  assert.equal(observed[0]?.youngDomainMaxAgeDays, 701);
  assert.equal(observed[0]?.recentWebPresenceMaxAgeDays, 702);
  assert.equal(observed[0]?.repurposeGapMinDays, 303);
  assert.deepEqual(observed[0]?.historicalPresence, {
    collectionMode: 'latest',
    recentMonths: 11,
    maxCollections: 13,
    domainCap: 17,
  });
});

test('decisions continuation updates only finalist evidence and publishes when all current decisions are supplied', async () => {
  let fullRuns = 0;
  let finalistRuns = 0;
  let publications = 0;
  const result = await runConfiguredFinalization(
    baseRequest(
      status('awaiting_decisions', { finalistCount: 2, currentDecisionCount: 0, matrix: true }),
      continuation({ type: 'decisions', path: 'decisions.json' }, '/tmp/decisions.json'),
    ),
    deps({
      runFullFinalization: async () => { fullRuns += 1; throw new Error('must not rerun full finalization'); },
      runFinalistEvidence: async (request) => {
        finalistRuns += 1;
        assert.equal(request.decisionsPath, '/tmp/decisions.json');
        return finalist(2, 2);
      },
      runLibraryPublication: async () => {
        publications += 1;
        return publication();
      },
    }),
  );
  assert.equal(result.outcome.kind, 'published');
  assert.equal(fullRuns, 0);
  assert.equal(finalistRuns, 1);
  assert.equal(publications, 1);
});

test('traffic continuation against an existing finalist matrix avoids Common Crawl/full rerun', async () => {
  let fullRuns = 0;
  const result = await runConfiguredFinalization(
    baseRequest(
      status('awaiting_decisions', { finalistCount: 2, currentDecisionCount: 0, matrix: true }),
      continuation({ type: 'traffic', path: 'traffic.csv', lowBaseOrganicTrafficThreshold: 100 }, '/tmp/traffic.csv'),
    ),
    deps({
      runFullFinalization: async () => { fullRuns += 1; throw new Error('must not rerun full finalization'); },
      runTrafficEvidence: async (request) => {
        assert.equal(request.inputPath, '/tmp/traffic.csv');
        assert.equal(request.lowBaseOrganicTrafficThreshold, 100);
        return traffic();
      },
      runFinalistEvidence: async (request) => {
        assert.equal(request.decisionsPath, null);
        return finalist(0, 2);
      },
    }),
  );
  assert.equal(result.outcome.kind, 'awaiting_decisions');
  assert.equal(fullRuns, 0);
  assert.equal(result.traffic?.inserted, 1);
});

test('publication override is a direct explicit publish and never reruns evidence', async () => {
  let publications = 0;
  const result = await runConfiguredFinalization(
    baseRequest(
      status('awaiting_decisions', { finalistCount: 2, currentDecisionCount: 0, matrix: true }),
      continuation({ type: 'publication_override', publishWithoutDecisions: true }),
    ),
    deps({
      runLibraryPublication: async () => {
        publications += 1;
        return publication();
      },
    }),
  );
  assert.equal(result.outcome.kind, 'published');
  assert.equal(publications, 1);
  assert.equal(result.fullRun, null);
  assert.equal(result.finalistEvidence, null);
});
