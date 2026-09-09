import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { outputLayout } from '../outputs/researchLayout.js';
import type { ResearchChromeStatus } from './researchChrome.js';
import { DEFAULT_UI_SERVER_DEPS, startUiServer, type UiServerDeps } from './server.js';

const root = resolve('/tmp/runner-ui-chrome-test-output');
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

const disconnected: ResearchChromeStatus = {
  version: 1,
  endpoint: 'http://127.0.0.1:9333',
  connected: false,
  browser: null,
  profileRoot: 'C:\\tmp\\research-profile',
  profileReady: true,
  controlSupported: true,
  controlReason: null,
  configurationError: null,
};

const connected: ResearchChromeStatus = {
  ...disconnected,
  connected: true,
  browser: 'Chrome/140',
};

function deps(overrides: Partial<UiServerDeps> = {}): UiServerDeps {
  return {
    ...DEFAULT_UI_SERVER_DEPS,
    buildOutputDiagnostics: async () => diagnostics,
    inspectResearchChrome: async () => disconnected,
    setupResearchChrome: async () => disconnected,
    startResearchChrome: async () => connected,
    loadStaticAssets: async () => new Map([
      ['/index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from('shell', 'utf8') }],
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

test('Research Chrome status is a dedicated read-only System projection', async () => {
  let observedCdp = '';
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: { CDP_URL: 'http://127.0.0.1:9444' },
    deps: deps({
      inspectResearchChrome: async (options) => {
        observedCdp = options.env?.CDP_URL ?? '';
        return { ...disconnected, endpoint: observedCdp };
      },
    }),
  });
  try {
    const response = await fetch(`${started.url}/api/system/research-chrome`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { researchChrome: ResearchChromeStatus };
    assert.equal(payload.researchChrome.endpoint, 'http://127.0.0.1:9444');
    assert.equal(observedCdp, 'http://127.0.0.1:9444');
  } finally {
    await started.close();
  }
});

test('setup and start expose only fixed empty-body same-origin machine actions', async () => {
  let setupCalls = 0;
  let startCalls = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      setupResearchChrome: async () => { setupCalls += 1; return disconnected; },
      startResearchChrome: async () => { startCalls += 1; return connected; },
    }),
  });
  try {
    const setup = await post(started.url, '/api/system/research-chrome/setup', {});
    assert.equal(setup.status, 200);
    assert.equal(setupCalls, 1);

    const start = await post(started.url, '/api/system/research-chrome/start', {});
    assert.equal(start.status, 200);
    const payload = await start.json() as { researchChrome: ResearchChromeStatus };
    assert.equal(payload.researchChrome.connected, true);
    assert.equal(startCalls, 1);

    const injected = await post(started.url, '/api/system/research-chrome/start', { command: 'calc.exe' });
    assert.equal(injected.status, 400);
    assert.equal(startCalls, 1);

    const foreign = await post(started.url, '/api/system/research-chrome/setup', {}, 'http://evil.example');
    assert.equal(foreign.status, 403);
    assert.equal(setupCalls, 1);
  } finally {
    await started.close();
  }
});
