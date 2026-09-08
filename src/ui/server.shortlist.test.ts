import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ResearchShortlistGateV1 } from '../application/researchShortlist.js';
import type { ResearchRunExecution } from '../application/researchWorkflow.js';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { outputLayout } from '../outputs/researchLayout.js';
import { DEFAULT_UI_SERVER_DEPS, startUiServer, type UiServerDeps } from './server.js';

const root = resolve('/tmp/runner-ui-shortlist-output');
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

const gate: ResearchShortlistGateV1 = {
  version: 1,
  researchId: 'research-1',
  discoveryRunId: 'run-1',
  minSelection: 5,
  maxSelection: 200,
  candidateCount: 5,
  candidates: Array.from({ length: 5 }, (_, index) => ({
    keyword: `Keyword ${index + 1}`,
    normalizedKeyword: `keyword ${index + 1}`,
    status: 'completed',
    surferVolume: 1000 - index,
    surferCpc: null,
    score: 70 - index,
    tier: 'B' as const,
    organicResultCount: 10,
    medianDr: 20,
    weakDomainsCount: 3,
    scoringCompleteness: 'complete' as const,
    serpStatus: 'observed',
  })),
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
    finalizationState: null,
    publicationId: null,
    workflowTarget: 'enrichment',
    workflowState: 'completed',
    stopPoint: 'complete',
    unresolvedHumanRequirements: [],
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
    inspectResearchShortlist: async () => gate,
    executeResearchShortlistSelection: async () => execution,
    loadStaticAssets: async () => new Map([
      ['/index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from('shell') }],
    ]),
    openBrowser: () => undefined,
    ...overrides,
  };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/researches/research-1/shortlist`, {
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
  discoveryRunId: 'run-1',
  normalizedKeywords: gate.candidates.map((candidate) => candidate.normalizedKeyword),
};

test('shortlist GET exposes read-only current candidate evidence', async () => {
  const started = await startUiServer({ port: 0, openBrowser: false, env: {}, deps: deps() });
  try {
    const response = await fetch(`${started.url}/api/researches/research-1/shortlist`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { shortlist: ResearchShortlistGateV1 };
    assert.deepEqual(payload.shortlist, gate);
  } finally {
    await started.close();
  }
});

test('shortlist POST starts a distinct workflow job with the exact submitted selection', async () => {
  let received: unknown = null;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      executeResearchShortlistSelection: async (researchId, value, options) => {
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
    const accepted = await response.json() as { job: { jobId: string; kind: string; state: string }; shortlist: ResearchShortlistGateV1 };
    assert.equal(accepted.job.kind, 'shortlist_research');
    assert.equal(accepted.job.state, 'running');
    assert.equal(accepted.shortlist.discoveryRunId, 'run-1');

    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const jobPayload = await fetch(`${started.url}/api/jobs/${accepted.job.jobId}`).then((value) => value.json()) as {
      job: { state: string; result: ResearchRunExecution['result'] | null };
    };
    assert.equal(jobPayload.job.state, 'finished');
    assert.equal(jobPayload.job.result?.enrichmentId, 'enrichment-1');
    assert.deepEqual(received, selection);
  } finally {
    await started.close();
  }
});

test('shortlist POST respects the global UI execution mutex', async () => {
  let finish: (value: ResearchRunExecution) => void = () => undefined;
  const blockedExecution = new Promise<ResearchRunExecution>((resolvePromise) => { finish = resolvePromise; });
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ executeResearchShortlistSelection: async () => blockedExecution }),
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
