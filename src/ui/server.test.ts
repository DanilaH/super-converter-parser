import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { outputLayout } from '../outputs/researchLayout.js';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import type { ResearchConsoleDetail } from '../application/researchConsole.js';
import type { ResearchCatalogItem } from '../application/researchCatalog.js';
import { startUiServer, type UiServerDeps } from './server.js';

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

const detail = {
  version: 1,
  status: { researchId: 'research-1' },
  container: null,
  operatorConfig: null,
} as unknown as ResearchConsoleDetail;

function deps(overrides: Partial<UiServerDeps> = {}): UiServerDeps {
  return {
    buildOutputDiagnostics: async () => diagnostics,
    listResearchCatalog: async () => [item],
    inspectResearchConsole: async () => detail,
    loadStaticAssets: async () => new Map([
      ['/index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from('shell', 'utf8') }],
      ['/app.js', { contentType: 'text/javascript; charset=utf-8', body: Buffer.from('app', 'utf8') }],
      ['/styles.css', { contentType: 'text/css; charset=utf-8', body: Buffer.from('css', 'utf8') }],
    ]),
    openBrowser: () => undefined,
    ...overrides,
  };
}

test('U1 server binds locally, serves static shell, and remains read-only', async () => {
  const started = await startUiServer({ port: 0, openBrowser: false, deps: deps(), env: {} });
  try {
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const rootResponse = await fetch(started.url);
    assert.equal(rootResponse.status, 200);
    assert.equal(await rootResponse.text(), 'shell');
    assert.match(rootResponse.headers.get('content-security-policy') ?? '', /default-src 'self'/);

    const postResponse = await fetch(`${started.url}/api/researches`, { method: 'POST' });
    assert.equal(postResponse.status, 405);
    const postPayload = await postResponse.json() as { error: { code: string } };
    assert.equal(postPayload.error.code, 'METHOD_NOT_ALLOWED');
  } finally {
    await started.close();
  }
});

test('research list query is filtered without loading expensive detail projections', async () => {
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

test('research detail route passes the stable identifier to the canonical detail projection', async () => {
  let observedId: string | null = null;
  let observedRoot: string | null = null;
  const serverDeps = deps({
    inspectResearchConsole: async (researchId, options) => {
      observedId = researchId;
      observedRoot = options.outputRoot ?? null;
      return detail;
    },
  });
  const started = await startUiServer({ port: 0, openBrowser: false, deps: serverDeps, env: {} });
  try {
    const response = await fetch(`${started.url}/api/researches/research-1`);
    assert.equal(response.status, 200);
    assert.equal(observedId, 'research-1');
    assert.equal(observedRoot, root);
  } finally {
    await started.close();
  }
});

test('system endpoint reports canonical output diagnostics', async () => {
  const started = await startUiServer({ port: 0, openBrowser: false, deps: deps(), env: {} });
  try {
    const response = await fetch(`${started.url}/api/system`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { outputs: OutputDiagnostics };
    assert.equal(payload.outputs.canonicalRoot, root);
    assert.equal(payload.outputs.overrideEscapeHatchEnabled, false);
  } finally {
    await started.close();
  }
});
