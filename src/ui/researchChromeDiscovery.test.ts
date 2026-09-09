import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureResearchChromeForDiscovery } from './researchChromeDiscovery.js';
import type { ResearchChromeStatus } from './researchChrome.js';

const ready: ResearchChromeStatus = {
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
  ...ready,
  connected: true,
  browser: 'Chrome/140',
};

test('discovery preflight is idempotent when Research Chrome is already connected', async () => {
  let starts = 0;
  const result = await ensureResearchChromeForDiscovery({}, {
    inspectResearchChrome: async () => connected,
    startResearchChrome: async () => { starts += 1; return connected; },
  });
  assert.equal(result, connected);
  assert.equal(starts, 0);
});

test('discovery preflight starts the managed local Chrome just in time', async () => {
  let starts = 0;
  const result = await ensureResearchChromeForDiscovery({ env: { CDP_URL: 'http://127.0.0.1:9333' } }, {
    inspectResearchChrome: async () => ready,
    startResearchChrome: async (options) => {
      starts += 1;
      assert.equal(options?.env?.CDP_URL, 'http://127.0.0.1:9333');
      return connected;
    },
  });
  assert.equal(result.connected, true);
  assert.equal(starts, 1);
});

test('discovery preflight fails clearly when one-time profile setup is still required', async () => {
  let starts = 0;
  await assert.rejects(
    ensureResearchChromeForDiscovery({}, {
      inspectResearchChrome: async () => ({ ...ready, profileReady: false }),
      startResearchChrome: async () => { starts += 1; return connected; },
    }),
    /Click "Setup once"/,
  );
  assert.equal(starts, 0);
});

test('discovery preflight does not take ownership of remote or unsupported CDP configurations', async () => {
  let starts = 0;
  const external = {
    ...ready,
    endpoint: 'http://192.0.2.20:9333',
    controlSupported: false,
    controlReason: 'Built-in control requires loopback HTTP.',
  };
  const result = await ensureResearchChromeForDiscovery({}, {
    inspectResearchChrome: async () => external,
    startResearchChrome: async () => { starts += 1; return connected; },
  });
  assert.equal(result, external);
  assert.equal(starts, 0);
});
