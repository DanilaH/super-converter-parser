import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ResearchCatalogItem } from '../application/researchCatalog.js';
import type { ResearchConsoleDetail } from '../application/researchConsole.js';
import type { ResearchRunExecution } from '../application/researchWorkflow.js';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { outputLayout } from '../outputs/researchLayout.js';
import type { ResearchChromeStatus } from './researchChrome.js';
import type { UiResearchPlanPreviewV1 } from './researchExecution.js';
import { DEFAULT_UI_SERVER_DEPS, startUiServer, type UiServerDeps } from './server.js';

const root = resolve('/tmp/runner-ui-test-output');
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

const item: ResearchCatalogItem = {
  researchId: 'research-1',
  label: 'Alpha tools',
  currentRunId: 'run-2',
  knownRunIds: ['research-1', 'run-2'],
  batchCount: 2,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  researchDirectory: resolve(root, 'researches', 'alpha-tools'),
  managed: true,
  operatorConfigAvailable: true,
};

function detailForAction(nextAction: string = 'run_enrichment'): ResearchConsoleDetail {
  return {
    version: 1,
    status: {
      researchId: 'research-1',
      nextAction: { code: nextAction },
    },
    container: null,
    operatorConfig: null,
  } as unknown as ResearchConsoleDetail;
}

const detail = detailForAction();

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

const execution: ResearchRunExecution = {
  exitCode: 0,
  result: {
    version: 1,
    exitCode: 0,
    researchId: 'research-new',
    discoveryRunId: 'run-new',
    discoveryState: 'completed',
    enrichmentId: null,
    enrichmentState: null,
    finalizationState: null,
    publicationId: null,
    workflowTarget: 'discovery',
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

const plan: UiResearchPlanPreviewV1 = {
  version: 1,
  inputLineCount: 2,
  uniqueKeywordCount: 2,
  effectiveConfigFingerprint: 'config',
  preset: { id: 'quick-scan', revision: 1 },
  workflowTarget: 'discovery',
  stages: [
    { id: 'discovery', state: 'ready', reason: null },
    { id: 'enrichment', state: 'not_requested', reason: null },
    { id: 'finalization', state: 'not_requested', reason: null },
  ],
  unresolvedHumanRequirements: [],
  externalWork: [],
  semantics: {
    research: { label: 'UI tools', market: 'US', googleHl: 'en', googleGl: 'us' },
    discovery: { topN: 10, expand: false, requireAhrefs: false },
    enrichmentModules: [],
    finalizationRequested: false,
  },
};

const draft = {
  version: 1,
  label: 'UI tools',
  preset: 'quick-scan',
  keywords: 'alpha\nbeta',
};

function deps(overrides: Partial<UiServerDeps> = {}): UiServerDeps {
  return {
    ...DEFAULT_UI_SERVER_DEPS,
    buildOutputDiagnostics: async () => diagnostics,
    listResearchCatalog: async () => [item],
    inspectResearchConsole: async () => detail,
    previewUiResearchDraft: async () => plan,
    executeUiResearchDraft: async () => execution,
    executeUiResearchResume: async () => execution,
    ensureResearchChromeForDiscovery: async () => connectedChrome,
    loadStaticAssets: async () => new Map([
      ['/index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from('shell', 'utf8') }],
      ['/app.js', { contentType: 'text/javascript; charset=utf-8', body: Buffer.from('app', 'utf8') }],
      ['/styles.css', { contentType: 'text/css; charset=utf-8', body: Buffer.from('css', 'utf8') }],
    ]),
    openBrowser: () => undefined,
    ...overrides,
  };
}

function post(url: string, path: string, body: unknown, origin = url): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('server binds locally and serves the browser shell with restrictive script policy', async () => {
  const started = await startUiServer({ port: 0, openBrowser: false, deps: deps(), env: {} });
  try {
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(started.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'shell');
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  } finally {
    await started.close();
  }
});

test('mutation endpoints fail closed without a same-origin loopback Origin', async () => {
  let executions = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ executeUiResearchDraft: async () => { executions += 1; return execution; } }),
  });
  try {
    const missing = await fetch(`${started.url}/api/researches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    assert.equal(missing.status, 403);
    assert.equal((await missing.json() as { error: { code: string } }).error.code, 'ORIGIN_NOT_ALLOWED');

    const foreign = await post(started.url, '/api/researches', draft, 'http://evil.example');
    assert.equal(foreign.status, 403);
    assert.equal(executions, 0);
  } finally {
    await started.close();
  }
});

test('plan preview is same-origin JSON and does not start an execution job', async () => {
  let executionCalls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ executeUiResearchDraft: async () => { executionCalls += 1; return execution; } }),
  });
  try {
    const response = await post(started.url, '/api/researches/plan', draft);
    assert.equal(response.status, 200);
    const payload = await response.json() as { plan: UiResearchPlanPreviewV1 };
    assert.equal(payload.plan.effectiveConfigFingerprint, 'config');
    assert.equal(payload.plan.uniqueKeywordCount, 2);
    assert.equal(executionCalls, 0);

    const jobs = await fetch(`${started.url}/api/jobs`).then((value) => value.json()) as { jobs: unknown[] };
    assert.deepEqual(jobs.jobs, []);
  } finally {
    await started.close();
  }
});

test('create starts one ephemeral job and publishes the canonical workflow result for polling', async () => {
  let executionCalls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ executeUiResearchDraft: async () => { executionCalls += 1; return execution; } }),
  });
  try {
    const response = await post(started.url, '/api/researches', draft);
    assert.equal(response.status, 202);
    const accepted = await response.json() as { job: { jobId: string; state: string }; plan: UiResearchPlanPreviewV1 };
    assert.equal(accepted.job.state, 'running');
    assert.equal(accepted.plan.workflowTarget, 'discovery');

    const job = await waitForFinishedJob(started.url, accepted.job.jobId);
    assert.equal(job.state, 'finished');
    assert.equal(job.researchId, 'research-new');
    assert.equal(job.result?.workflowState, 'completed');
    assert.equal(executionCalls, 1);
  } finally {
    await started.close();
  }
});

test('a second UI execution is rejected while the first job is still running', async () => {
  let finish: (value: ResearchRunExecution) => void = () => {
    throw new Error('Deferred execution resolver was not initialized.');
  };
  const pending = new Promise<ResearchRunExecution>((resolvePromise) => { finish = resolvePromise; });
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ executeUiResearchDraft: async () => pending }),
  });
  try {
    const first = await post(started.url, '/api/researches', draft);
    assert.equal(first.status, 202);
    const second = await post(started.url, '/api/researches', draft);
    assert.equal(second.status, 409);
    const payload = await second.json() as { error: { code: string; activeJob: { state: string } } };
    assert.equal(payload.error.code, 'UI_JOB_BUSY');
    assert.equal(payload.error.activeJob.state, 'running');
  } finally {
    finish(execution);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    await started.close();
  }
});

test('resume discovery preflights Research Chrome inside the admitted job before application workflow', async () => {
  let inspectedId = '';
  let resumedId = '';
  const sequence: string[] = [];
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: { CDP_URL: 'http://127.0.0.1:9333' },
    deps: deps({
      inspectResearchConsole: async (researchId) => {
        inspectedId = researchId;
        return detailForAction('resume_discovery');
      },
      ensureResearchChromeForDiscovery: async (options) => {
        sequence.push(`chrome:${options?.env?.CDP_URL ?? ''}`);
        return connectedChrome;
      },
      executeUiResearchResume: async (researchId) => {
        resumedId = researchId;
        sequence.push('resume');
        return execution;
      },
    }),
  });
  try {
    const response = await post(started.url, '/api/researches/research-1/resume', {});
    assert.equal(response.status, 202);
    const accepted = await response.json() as { job: { jobId: string } };
    await waitForFinishedJob(started.url, accepted.job.jobId);
    assert.equal(inspectedId, 'research-1');
    assert.equal(resumedId, 'research-1');
    assert.deepEqual(sequence, ['chrome:http://127.0.0.1:9333', 'resume']);
  } finally {
    await started.close();
  }
});

test('non-discovery continuation does not start Research Chrome', async () => {
  let chromeCalls = 0;
  let resumeCalls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      inspectResearchConsole: async () => detailForAction('run_enrichment'),
      ensureResearchChromeForDiscovery: async () => { chromeCalls += 1; return connectedChrome; },
      executeUiResearchResume: async () => { resumeCalls += 1; return execution; },
    }),
  });
  try {
    const response = await post(started.url, '/api/researches/research-1/resume', {});
    assert.equal(response.status, 202);
    const accepted = await response.json() as { job: { jobId: string } };
    await waitForFinishedJob(started.url, accepted.job.jobId);
    assert.equal(chromeCalls, 0);
    assert.equal(resumeCalls, 1);
  } finally {
    await started.close();
  }
});

test('research list query stays lightweight and does not load detail projections', async () => {
  let detailCalls = 0;
  const serverDeps = deps({
    listResearchCatalog: async () => [
      item,
      { ...item, researchId: 'research-2', label: 'Beta tools', currentRunId: 'run-beta', knownRunIds: ['research-2', 'run-beta'] },
    ],
    inspectResearchConsole: async () => {
      detailCalls += 1;
      return detail;
    },
  });
  const started = await startUiServer({ port: 0, openBrowser: false, deps: serverDeps, env: {} });
  try {
    const response = await fetch(`${started.url}/api/researches?q=alpha`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { researches: ResearchCatalogItem[] };
    assert.deepEqual(payload.researches.map((research) => research.researchId), ['research-1']);
    assert.equal(detailCalls, 0);
  } finally {
    await started.close();
  }
});

test('research detail and system endpoints keep canonical read-only projections', async () => {
  let observedId: string | null = null;
  let observedRoot: string | null = null;
  const serverDeps = deps({
    inspectResearchConsole: async (researchId, options) => {
      observedId = researchId;
      observedRoot = options?.outputRoot ?? null;
      return detail;
    },
  });
  const started = await startUiServer({ port: 0, openBrowser: false, deps: serverDeps, env: {} });
  try {
    const detailResponse = await fetch(`${started.url}/api/researches/research-1`);
    assert.equal(detailResponse.status, 200);
    assert.equal(observedId, 'research-1');
    assert.equal(observedRoot, root);

    const systemResponse = await fetch(`${started.url}/api/system`);
    assert.equal(systemResponse.status, 200);
    const payload = await systemResponse.json() as { outputs: OutputDiagnostics };
    assert.equal(payload.outputs.canonicalRoot, root);
  } finally {
    await started.close();
  }
});

async function waitForFinishedJob(
  url: string,
  jobId: string,
): Promise<{ state: string; researchId: string | null; result?: ResearchRunExecution['result'] | null }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${url}/api/jobs/${encodeURIComponent(jobId)}`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { job: { state: string; researchId: string | null; result?: ResearchRunExecution['result'] | null } };
    if (payload.job.state !== 'running') return payload.job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Job ${jobId} did not finish in time.`);
}
