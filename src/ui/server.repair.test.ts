import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ResearchConsoleDetail } from '../application/researchConsole.js';
import type { ResearchDiscoveryRepairResultV1 } from '../application/researchRepair.js';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { outputLayout } from '../outputs/researchLayout.js';
import { DEFAULT_UI_SERVER_DEPS, startUiServer, type UiServerDeps } from './server.js';

const root = resolve('/tmp/runner-ui-repair-output');
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

function detail(nextAction = 'repair_discovery', repairable = 2): ResearchConsoleDetail {
  return {
    version: 1,
    status: {
      researchId: 'research-1',
      discovery: {
        runId: 'run-1',
        keywordCounts: { repairable },
      },
      nextAction: { code: nextAction },
    },
    container: null,
    operatorConfig: null,
  } as unknown as ResearchConsoleDetail;
}

const repairResult: ResearchDiscoveryRepairResultV1 = {
  version: 1,
  researchId: 'research-1',
  discoveryRunId: 'run-1',
  exitCode: 0,
  discoveryState: 'completed',
  repairableBefore: 2,
  repairableAfter: 0,
};

function deps(overrides: Partial<UiServerDeps> = {}): UiServerDeps {
  return {
    ...DEFAULT_UI_SERVER_DEPS,
    buildOutputDiagnostics: async () => diagnostics,
    inspectResearchConsole: async () => detail(),
    repairResearchDiscovery: async () => repairResult,
    loadStaticAssets: async () => new Map([
      ['/index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from('shell') }],
    ]),
    openBrowser: () => undefined,
    ...overrides,
  };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/researches/research-1/repair-discovery`, {
    method: 'POST',
    headers: {
      Origin: url,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('repair endpoint starts a distinct repair job after canonical preflight', async () => {
  let calls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ repairResearchDiscovery: async (researchId, options) => {
      calls += 1;
      assert.equal(researchId, 'research-1');
      assert.equal(options?.outputRoot, root);
      return repairResult;
    } }),
  });
  try {
    const response = await post(started.url, {});
    assert.equal(response.status, 202);
    const accepted = await response.json() as { job: { jobId: string; kind: string; state: string } };
    assert.equal(accepted.job.kind, 'repair_discovery');
    assert.equal(accepted.job.state, 'running');

    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const jobResponse = await fetch(`${started.url}/api/jobs/${accepted.job.jobId}`);
    const payload = await jobResponse.json() as { job: { state: string; result: unknown; repairResult: ResearchDiscoveryRepairResultV1 | null } };
    assert.equal(payload.job.state, 'finished');
    assert.equal(payload.job.result, null);
    assert.deepEqual(payload.job.repairResult, repairResult);
    assert.equal(calls, 1);
  } finally {
    await started.close();
  }
});

test('repair endpoint fails closed when canonical status no longer authorizes repair', async () => {
  let calls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      inspectResearchConsole: async () => detail('run_enrichment', 0),
      repairResearchDiscovery: async () => { calls += 1; return repairResult; },
    }),
  });
  try {
    const response = await post(started.url, {});
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, 'INPUT_SCHEMA_ERROR');
  } finally {
    await started.close();
  }
});

test('repair endpoint accepts only an empty JSON object', async () => {
  let calls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ repairResearchDiscovery: async () => { calls += 1; return repairResult; } }),
  });
  try {
    const response = await post(started.url, { retryFailed: false });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  } finally {
    await started.close();
  }
});
