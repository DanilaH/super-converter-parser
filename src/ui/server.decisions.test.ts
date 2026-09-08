import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ResearchDecisionGateV1 } from '../application/researchDecisions.js';
import type { ResearchRunExecution } from '../application/researchWorkflow.js';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { outputLayout } from '../outputs/researchLayout.js';
import { DEFAULT_UI_SERVER_DEPS, startUiServer, type UiServerDeps } from './server.js';

const root = resolve('/tmp/runner-ui-decision-output');
const fingerprint = 'a'.repeat(64);
const diagnostics: OutputDiagnostics = {
  version: 1,
  canonicalRoot: root,
  configuredBy: 'home_default',
  layout: outputLayout(root),
  overrideEscapeHatchEnabled: false,
  rootExists: true,
  researchesDirectoryExists: true,
  repoLocalLegacyDirectories: [],
};

const gate = {
  version: 1,
  researchId: 'research-1',
  discoveryRunId: 'run-1',
  enrichmentId: 'enrichment-1',
  representativeRevision: 2,
  entrantFingerprint: fingerprint,
  decisionStateUpdatedAt: null,
  finalistCount: 2,
  currentDecisionCount: 0,
  buildDecisionValues: ['build', 'watch', 'reject', 'unknown'],
  seoProductRoleValues: ['acquisition_anchor', 'strong_supporting_tool', 'completeness_tool', 'experimental', 'not_applicable'],
  finalists: [
    {
      clusterId: 'cluster-1',
      canonicalKeyword: 'mic test',
      representativeKeywordIds: [1],
      evidence: {},
      auditFlags: ['HUMAN_DECISION_UNRECORDED'],
      currentDecision: null,
    },
    {
      clusterId: 'cluster-2',
      canonicalKeyword: 'speaker test',
      representativeKeywordIds: [2],
      evidence: {},
      auditFlags: ['HUMAN_DECISION_UNRECORDED'],
      currentDecision: null,
    },
  ],
} as unknown as ResearchDecisionGateV1;

const execution: ResearchRunExecution = {
  exitCode: 0,
  result: {
    version: 1,
    exitCode: 0,
    researchId: 'research-1',
    discoveryRunId: 'run-1',
    discoveryState: 'completed',
    enrichmentId: 'enrichment-1',
    enrichmentState: 'completed',
    finalizationState: 'awaiting_decisions',
    publicationId: null,
    workflowTarget: 'finalization',
    workflowState: 'awaiting_decisions',
    stopPoint: 'finalization',
    unresolvedHumanRequirements: ['human_decisions'],
    effectiveConfigFingerprint: 'config',
    stageFingerprints: {
      discoverySemanticFingerprint: 'discovery',
      enrichmentSemanticFingerprint: 'enrichment',
      finalizationPolicyFingerprint: 'finalization',
    },
    operatorConfigPath: null,
  },
};

function deps(overrides: Partial<UiServerDeps> = {}): UiServerDeps {
  return {
    ...DEFAULT_UI_SERVER_DEPS,
    buildOutputDiagnostics: async () => diagnostics,
    inspectResearchDecisions: async () => gate,
    executeResearchDecisionSelection: async () => execution,
    loadStaticAssets: async () => new Map([
      ['/index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from('shell') }],
    ]),
    openBrowser: () => undefined,
    ...overrides,
  };
}

const selection = {
  version: 1,
  discoveryRunId: 'run-1',
  enrichmentId: 'enrichment-1',
  representativeRevision: 2,
  entrantFingerprint: fingerprint,
  decisionStateUpdatedAt: null,
  decisions: [
    { clusterId: 'cluster-1', buildDecision: 'build', seoProductRole: 'acquisition_anchor' },
    { clusterId: 'cluster-2', buildDecision: null, seoProductRole: null },
  ],
};

function post(url: string, body: unknown, origin = url): Promise<Response> {
  return fetch(`${url}/api/researches/research-1/decisions`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('human decisions GET exposes the current canonical decision gate', async () => {
  const started = await startUiServer({ port: 0, openBrowser: false, env: {}, deps: deps() });
  try {
    const response = await fetch(`${started.url}/api/researches/research-1/decisions`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { decisions: ResearchDecisionGateV1 };
    assert.deepEqual(payload.decisions, gate);
  } finally {
    await started.close();
  }
});

test('human decisions POST starts a distinct workflow job and preserves the exact submitted snapshot', async () => {
  let received: unknown = null;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      executeResearchDecisionSelection: async (researchId, value, options) => {
        assert.equal(researchId, 'research-1');
        assert.equal(options?.outputRoot, root);
        received = value;
        return execution;
      },
    }),
  });
  try {
    const response = await post(started.url, selection);
    assert.equal(response.status, 202);
    const accepted = await response.json() as {
      job: { jobId: string; kind: string; state: string };
      decisions: ResearchDecisionGateV1;
    };
    assert.equal(accepted.job.kind, 'decisions_research');
    assert.equal(accepted.job.state, 'running');
    assert.equal(accepted.decisions.representativeRevision, 2);

    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const jobPayload = await fetch(`${started.url}/api/jobs/${accepted.job.jobId}`).then((value) => value.json()) as {
      job: { state: string; result: ResearchRunExecution['result'] | null };
    };
    assert.equal(jobPayload.job.state, 'finished');
    assert.equal(jobPayload.job.result?.workflowState, 'awaiting_decisions');
    assert.deepEqual(received, selection);
  } finally {
    await started.close();
  }
});

test('human decisions POST respects the global UI execution mutex', async () => {
  let finish: (value: ResearchRunExecution) => void = () => undefined;
  const blockedExecution = new Promise<ResearchRunExecution>((resolvePromise) => { finish = resolvePromise; });
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ executeResearchDecisionSelection: async () => blockedExecution }),
  });
  try {
    const first = await post(started.url, selection);
    assert.equal(first.status, 202);
    const second = await post(started.url, selection);
    assert.equal(second.status, 409);
    const payload = await second.json() as { error: { code: string } };
    assert.equal(payload.error.code, 'UI_JOB_BUSY');
  } finally {
    finish(execution);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    await started.close();
  }
});

test('human decisions POST remains protected by the same-origin loopback mutation gate', async () => {
  const started = await startUiServer({ port: 0, openBrowser: false, env: {}, deps: deps() });
  try {
    const response = await post(started.url, selection, 'https://example.com');
    assert.equal(response.status, 403);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, 'ORIGIN_NOT_ALLOWED');
  } finally {
    await started.close();
  }
});
