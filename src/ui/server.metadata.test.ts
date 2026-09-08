import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ResearchRunExecution } from '../application/researchWorkflow.js';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { outputLayout } from '../outputs/researchLayout.js';
import { UiJobRegistry } from './jobs.js';
import { DEFAULT_UI_SERVER_DEPS, startUiServer, type UiServerDeps } from './server.js';

const root = resolve('/tmp/runner-ui-label-output');
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

const execution: ResearchRunExecution = {
  exitCode: 0,
  result: {
    version: 1,
    exitCode: 0,
    researchId: 'research-1',
    discoveryRunId: 'research-1',
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

function deps(overrides: Partial<UiServerDeps> = {}): UiServerDeps {
  return {
    ...DEFAULT_UI_SERVER_DEPS,
    buildOutputDiagnostics: async () => diagnostics,
    listResearchCatalog: async () => [],
    inspectResearchConsole: async () => { throw new Error('detail not expected'); },
    loadStaticAssets: async () => new Map([
      ['/index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from('shell') }],
    ]),
    openBrowser: () => undefined,
    ...overrides,
  };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/researches/research-1/label`, {
    method: 'POST',
    headers: {
      Origin: url,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

test('default static loader serves external research metadata editor assets', async () => {
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: {
      ...DEFAULT_UI_SERVER_DEPS,
      buildOutputDiagnostics: async () => diagnostics,
      listResearchCatalog: async () => [],
      inspectResearchConsole: async () => { throw new Error('detail not expected'); },
      openBrowser: () => undefined,
    },
  });
  try {
    const script = await fetch(`${started.url}/metadata.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /text\/javascript/);
    assert.match(await script.text(), /metadata-action-root/);

    const stylesheet = await fetch(`${started.url}/metadata.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type') ?? '', /text\/css/);
    assert.match(await stylesheet.text(), /metadata-action-shell/);
  } finally {
    await started.close();
  }
});

test('label endpoint delegates to the serialized application action and returns committed metadata', async () => {
  let observedId = '';
  let observedLabel: unknown = null;
  let observedRoot: string | null = null;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      renameResearchLabel: async (researchId, label, options) => {
        observedId = researchId;
        observedLabel = label;
        observedRoot = options?.outputRoot ?? null;
        return {
          version: 1,
          researchId: 'research-1',
          researchDirectory: '/output/research-1',
          previousLabel: 'Old label',
          label: 'New label',
          changed: true,
          updatedAt: '2026-09-08T12:30:00.000Z',
          archiveWarning: null,
        };
      },
    }),
  });
  try {
    const response = await post(started.url, { label: 'New label' });
    assert.equal(response.status, 200);
    const payload = await response.json() as { rename: { researchId: string; label: string; changed: boolean } };
    assert.equal(payload.rename.researchId, 'research-1');
    assert.equal(payload.rename.label, 'New label');
    assert.equal(payload.rename.changed, true);
    assert.equal(observedId, 'research-1');
    assert.equal(observedLabel, 'New label');
    assert.equal(observedRoot, root);
  } finally {
    await started.close();
  }
});

test('label endpoint rejects non-exact request bodies before mutation', async () => {
  let calls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      renameResearchLabel: async (...args) => {
        calls += 1;
        return DEFAULT_UI_SERVER_DEPS.renameResearchLabel(...args);
      },
    }),
  });
  try {
    const response = await post(started.url, { label: 'New label', extra: true });
    assert.equal(response.status, 400);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, 'INPUT_SCHEMA_ERROR');
    assert.equal(calls, 0);
  } finally {
    await started.close();
  }
});

test('known active UI execution blocks display-label mutation before application call', async () => {
  let finish: (value: ResearchRunExecution) => void = () => {
    throw new Error('Deferred job resolver was not initialized.');
  };
  const pending = new Promise<ResearchRunExecution>((resolvePromise) => { finish = resolvePromise; });
  const jobs = new UiJobRegistry({ createId: () => 'active-job' });
  jobs.start('resume_research', 'research-1', async () => pending);
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

  let calls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    jobs,
    deps: deps({
      renameResearchLabel: async (...args) => {
        calls += 1;
        return DEFAULT_UI_SERVER_DEPS.renameResearchLabel(...args);
      },
    }),
  });
  try {
    const response = await post(started.url, { label: 'New label' });
    assert.equal(response.status, 409);
    const payload = await response.json() as { error: { code: string; activeJob: { jobId: string } } };
    assert.equal(payload.error.code, 'UI_JOB_BUSY');
    assert.equal(payload.error.activeJob.jobId, 'active-job');
    assert.equal(calls, 0);
  } finally {
    finish(execution);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    await started.close();
  }
});
