import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ResearchConsoleDetail } from '../application/researchConsole.js';
import type { ResearchDiscoveryRepairResultV1 } from '../application/researchRepair.js';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { outputLayout } from '../outputs/researchLayout.js';
import type { ResearchChromeStatus } from './researchChrome.js';
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

const connectedChrome: ResearchChromeStatus = {
  version: 1,
  endpoint: 'http://127.0.0.1:9333',
  connected: true,
  browser: 'Chrome/140',
  profileRoot: 'C:\\tmp\\research-profile',
  profileReady: true,
  controlSupported: true,
  controlReason: null,
  configurationError: null,
};

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
    ensureResearchChromeForDiscovery: async () => connectedChrome,
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

test('repair endpoint preflights Research Chrome inside the admitted repair job before canonical repair', async () => {
  const sequence: string[] = [];
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: { CDP_URL: 'http://127.0.0.1:9333' },
    deps: deps({
      ensureResearchChromeForDiscovery: async (options) => {
        sequence.push(`chrome:${options?.env?.CDP_URL ?? ''}`);
        return connectedChrome;
      },
      repairResearchDiscovery: async (researchId, options) => {
        sequence.push('repair');
        assert.equal(researchId, 'research-1');
        assert.equal(options?.outputRoot, root);
        return repairResult;
      },
    }),
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
    assert.deepEqual(sequence, ['chrome:http://127.0.0.1:9333', 'repair']);
  } finally {
    await started.close();
  }
});

test('repair endpoint fails closed when canonical status no longer authorizes repair', async () => {
  let repairCalls = 0;
  let chromeCalls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      inspectResearchConsole: async () => detail('run_enrichment', 0),
      ensureResearchChromeForDiscovery: async () => { chromeCalls += 1; return connectedChrome; },
      repairResearchDiscovery: async () => { repairCalls += 1; return repairResult; },
    }),
  });
  try {
    const response = await post(started.url, {});
    assert.equal(response.status, 400);
    assert.equal(repairCalls, 0);
    assert.equal(chromeCalls, 0);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, 'INPUT_SCHEMA_ERROR');
  } finally {
    await started.close();
  }
});

test('repair endpoint accepts only an empty JSON object', async () => {
  let calls = 0;
  let chromeCalls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      ensureResearchChromeForDiscovery: async () => { chromeCalls += 1; return connectedChrome; },
      repairResearchDiscovery: async () => { calls += 1; return repairResult; },
    }),
  });
  try {
    const response = await post(started.url, { retryFailed: false });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
    assert.equal(chromeCalls, 0);
  } finally {
    await started.close();
  }
});
