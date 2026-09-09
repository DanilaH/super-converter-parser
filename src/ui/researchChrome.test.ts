import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectResearchChrome,
  setupResearchChrome,
  startResearchChrome,
} from './researchChrome.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readyProfileAccess(path: string): Promise<void> {
  if (path.endsWith('.runner-profile-incomplete')) throw new Error('marker absent');
}

test('status reports configured CDP independently from Windows-only process control', async () => {
  const status = await inspectResearchChrome({
    env: { CDP_URL: 'http://127.0.0.1:9333' },
    runtime: {
      platform: 'linux',
      fetchImpl: (async () => jsonResponse({ Browser: 'Chrome/140' })) as typeof fetch,
    },
  });

  assert.equal(status.endpoint, 'http://127.0.0.1:9333');
  assert.equal(status.connected, true);
  assert.equal(status.browser, 'Chrome/140');
  assert.equal(status.profileReady, null);
  assert.equal(status.controlSupported, false);
  assert.match(status.controlReason ?? '', /Windows only/);
});

test('status requires a real CDP Browser field rather than any 200 JSON response', async () => {
  const status = await inspectResearchChrome({
    env: { CDP_URL: 'http://127.0.0.1:9333' },
    runtime: {
      platform: 'win32',
      accessPath: readyProfileAccess,
      fetchImpl: (async () => jsonResponse({ ok: true })) as typeof fetch,
    },
  });

  assert.equal(status.connected, false);
  assert.equal(status.browser, null);
  assert.equal(status.profileReady, true);
});

test('an incomplete setup marker keeps a partially copied profile non-ready', async () => {
  const status = await inspectResearchChrome({
    env: { CDP_URL: 'http://127.0.0.1:9333' },
    runtime: {
      platform: 'win32',
      accessPath: async () => undefined,
      fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
    },
  });

  assert.equal(status.profileReady, false);
  assert.equal(status.connected, false);
});

test('malformed CDP configuration fails read-only inspection closed without throwing', async () => {
  let fetchCalls = 0;
  const status = await inspectResearchChrome({
    env: { CDP_URL: 'not a url' },
    runtime: {
      platform: 'win32',
      accessPath: readyProfileAccess,
      fetchImpl: (async () => { fetchCalls += 1; return jsonResponse({}); }) as typeof fetch,
    },
  });

  assert.equal(status.connected, false);
  assert.equal(status.controlSupported, false);
  assert.match(status.configurationError ?? '', /not a valid URL/);
  assert.equal(fetchCalls, 0);
});

test('remote CDP can be observed but is never accepted as a launch target', async () => {
  const status = await inspectResearchChrome({
    env: { CDP_URL: 'http://192.0.2.10:9333' },
    runtime: {
      platform: 'win32',
      accessPath: readyProfileAccess,
      fetchImpl: (async () => jsonResponse({ Browser: 'Chrome/140' })) as typeof fetch,
    },
  });
  assert.equal(status.connected, true);
  assert.equal(status.controlSupported, false);
  assert.match(status.controlReason ?? '', /loopback HTTP/);

  await assert.rejects(
    startResearchChrome({
      env: { CDP_URL: 'http://192.0.2.10:9333' },
      runtime: {
        platform: 'win32',
        accessPath: readyProfileAccess,
        fetchImpl: (async () => jsonResponse({ Browser: 'Chrome/140' })) as typeof fetch,
        runScript: async () => { throw new Error('must not run'); },
      },
    }),
    /loopback HTTP/,
  );
});

test('start is idempotent when configured Research Chrome is already connected', async () => {
  let scriptCalls = 0;
  const status = await startResearchChrome({
    env: { CDP_URL: 'http://localhost:9333' },
    runtime: {
      platform: 'win32',
      accessPath: readyProfileAccess,
      fetchImpl: (async () => jsonResponse({ Browser: 'Chrome/140' })) as typeof fetch,
      runScript: async () => { scriptCalls += 1; },
    },
  });

  assert.equal(status.connected, true);
  assert.equal(scriptCalls, 0);
});

test('start requires the dedicated profile before launching Chrome', async () => {
  let scriptCalls = 0;
  await assert.rejects(
    startResearchChrome({
      env: { CDP_URL: 'http://127.0.0.1:9333' },
      runtime: {
        platform: 'win32',
        accessPath: async () => { throw new Error('missing'); },
        fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
        runScript: async () => { scriptCalls += 1; },
      },
    }),
    /Run Setup Research Chrome once/,
  );
  assert.equal(scriptCalls, 0);
});

test('start uses only the fixed script mode, managed profile, and configured local CDP port', async () => {
  let connected = false;
  const scriptInputs: Array<{ mode: string; profileRoot: string; port: number }> = [];
  const status = await startResearchChrome({
    env: { CDP_URL: 'http://127.0.0.1:9444' },
    runtime: {
      platform: 'win32',
      accessPath: readyProfileAccess,
      fetchImpl: (async () => connected
        ? jsonResponse({ Browser: 'Chrome/140' })
        : (() => { throw new Error('offline'); })()) as typeof fetch,
      runScript: async (input) => {
        scriptInputs.push(input);
        connected = true;
      },
    },
  });

  assert.equal(status.connected, true);
  assert.deepEqual(scriptInputs, [{ mode: 'start', profileRoot: 'C:\\tmp\\research-profile', port: 9444 }]);
});

test('setup is idempotent after the dedicated profile exists and otherwise uses fixed setup mode', async () => {
  let profileReady = false;
  const scriptInputs: Array<{ mode: string; profileRoot: string; port: number }> = [];
  const options = {
    env: { CDP_URL: 'http://127.0.0.1:9333' },
    runtime: {
      platform: 'win32' as const,
      accessPath: async (path: string) => {
        if (path.endsWith('.runner-profile-incomplete')) throw new Error('marker absent');
        if (!profileReady) throw new Error('profile missing');
      },
      fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
      runScript: async (input: { mode: 'setup' | 'start'; profileRoot: string; port: number }) => {
        scriptInputs.push(input);
        profileReady = true;
      },
    },
  };

  const first = await setupResearchChrome(options);
  assert.equal(first.profileReady, true);
  assert.deepEqual(scriptInputs, [{ mode: 'setup', profileRoot: 'C:\\tmp\\research-profile', port: 9333 }]);

  const second = await setupResearchChrome(options);
  assert.equal(second.profileReady, true);
  assert.equal(scriptInputs.length, 1);
});
