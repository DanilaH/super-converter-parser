import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ResearchFinalistScopeGateV1 } from '../application/researchFinalists.js';
import type { ResearchRunExecution } from '../application/researchWorkflow.js';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { outputLayout } from '../outputs/researchLayout.js';
import { DEFAULT_UI_SERVER_DEPS, startUiServer, type UiServerDeps } from './server.js';

const root = resolve('/tmp/runner-ui-finalist-output');
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

const gate: ResearchFinalistScopeGateV1 = {
  version: 1,
  researchId: 'research-1',
  discoveryRunId: 'run-1',
  enrichmentId: 'enrichment-1',
  clusterCount: 2,
  clusters: [
    {
      clusterId: 'cluster-1',
      canonicalKeyword: 'mic test',
      memberCount: 2,
      medianVolume: 900,
      averageVolume: 850,
      representativeDomains: ['example.com'],
      cohesion: { urlJaccardMedian: 0.5, domainJaccardMedian: 0.6 },
      members: [
        { keyword: 'mic test', normalizedKeyword: 'mic test', volume: 1000, serpSize: 10 },
        { keyword: 'microphone test', normalizedKeyword: 'microphone test', volume: 700, serpSize: 10 },
      ],
    },
    {
      clusterId: 'cluster-2',
      canonicalKeyword: 'speaker test',
      memberCount: 1,
      medianVolume: 600,
      averageVolume: 600,
      representativeDomains: ['audio.example'],
      cohesion: null,
      members: [
        { keyword: 'speaker test', normalizedKeyword: 'speaker test', volume: 600, serpSize: 10 },
      ],
    },
  ],
};

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
    inspectResearchFinalistScope: async () => gate,
    executeResearchFinalistScopeSelection: async () => execution,
    loadStaticAssets: async () => new Map([
      ['/index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from('shell') }],
    ]),
    openBrowser: () => undefined,
    ...overrides,
  };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/researches/research-1/finalist-scope`, {
    method: 'POST',
    headers: {
      Origin: url,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const selection = {
  version: 1,
  enrichmentId: 'enrichment-1',
  mode: 'selected',
  clusterIds: ['cluster-2'],
};

test('finalist scope GET exposes read-only current clustering evidence', async () => {
  const started = await startUiServer({ port: 0, openBrowser: false, env: {}, deps: deps() });
  try {
    const response = await fetch(`${started.url}/api/researches/research-1/finalist-scope`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { finalistScope: ResearchFinalistScopeGateV1 };
    assert.deepEqual(payload.finalistScope, gate);
  } finally {
    await started.close();
  }
});

test('finalist scope POST starts a distinct workflow job with the exact submitted selection', async () => {
  let received: unknown = null;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      executeResearchFinalistScopeSelection: async (researchId, value, options) => {
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
      finalistScope: ResearchFinalistScopeGateV1;
    };
    assert.equal(accepted.job.kind, 'finalist_scope_research');
    assert.equal(accepted.job.state, 'running');
    assert.equal(accepted.finalistScope.enrichmentId, 'enrichment-1');

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

test('finalist scope POST preserves explicit all mode at the HTTP/application boundary', async () => {
  let received: unknown = null;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      executeResearchFinalistScopeSelection: async (_researchId, value) => {
        received = value;
        return execution;
      },
    }),
  });
  try {
    const all = { version: 1, enrichmentId: 'enrichment-1', mode: 'all' };
    const response = await post(started.url, all);
    assert.equal(response.status, 202);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(received, all);
  } finally {
    await started.close();
  }
});

test('finalist scope POST respects the global UI execution mutex', async () => {
  let finish: (value: ResearchRunExecution) => void = () => undefined;
  const blockedExecution = new Promise<ResearchRunExecution>((resolvePromise) => { finish = resolvePromise; });
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ executeResearchFinalistScopeSelection: async () => blockedExecution }),
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
