import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfiguredEnrichmentResult } from '../enrichment/configuredRun.js';
import type { CancellationSignal } from '../enrichment/types.js';
import type { ExistingResearchExecutionPlan } from '../operatorConfig/planner.js';
import type { PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  runResearchFromExisting,
  type ResearchRunDeps,
} from './researchWorkflow.js';

const status = {
  researchId: 'research-1',
  researchDirectory: '/tmp/research-1',
  currentEnrichmentId: null,
  discovery: { runId: 'run-1', state: 'completed' },
  enrichments: [],
  finalization: { state: 'not_started' },
  library: { publicationId: null },
} as unknown as ResearchStatusWithHistoricalPresence;

const provenance = {
  semantics: { workflow: { target: 'enrichment' } },
  effectiveConfigFingerprint: 'config',
  stageFingerprints: {
    discoverySemanticFingerprint: 'discovery',
    enrichmentSemanticFingerprint: 'enrichment',
    finalizationPolicyFingerprint: 'finalization',
  },
} as unknown as PersistedOperatorConfigV1;

const plan = {
  stages: [
    { id: 'discovery', state: 'already_satisfied', reason: null },
    { id: 'enrichment', state: 'ready', reason: null },
    { id: 'finalization', state: 'not_requested', reason: null },
  ],
  unresolvedHumanRequirements: [],
  expectedStopPoint: 'enrichment',
} as unknown as ExistingResearchExecutionPlan;

const completed = {
  outcome: { kind: 'completed', state: 'completed' },
  enrichmentId: 'enrichment-1',
  enrichmentDirectory: '/tmp/research-1/enrichment-1',
  resumed: false,
  archivePath: null,
} as unknown as ConfiguredEnrichmentResult;

test('host-owned cancellation skips temporary SIGINT and SIGTERM listeners around enrichment', async () => {
  const beforeSigint = process.listenerCount('SIGINT');
  const beforeSigterm = process.listenerCount('SIGTERM');
  let observedSigint = -1;
  let observedSigterm = -1;

  const deps: ResearchRunDeps = {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    buildStatus: async () => status,
    loadProvenance: async () => provenance,
    buildExistingPlan: () => plan,
    acquireExecutionLock: async () => async () => undefined,
    runConfiguredEnrichment: async () => {
      observedSigint = process.listenerCount('SIGINT');
      observedSigterm = process.listenerCount('SIGTERM');
      return completed;
    },
  };
  const signal = {
    cancelled: false,
    manageProcessSignals: false,
  } as CancellationSignal & { manageProcessSignals: false };

  const execution = await runResearchFromExisting(
    'research-1',
    null,
    null,
    deps,
    { RESEARCH_OUTPUT_ROOT: '/tmp/runner-ui-signal-policy' },
    signal,
  );

  assert.equal(execution.exitCode, 0);
  assert.equal(observedSigint, beforeSigint);
  assert.equal(observedSigterm, beforeSigterm);
  assert.equal(process.listenerCount('SIGINT'), beforeSigint);
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);
});
