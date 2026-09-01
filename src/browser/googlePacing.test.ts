import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserCollectionTiming } from './collect.js';
import { conservativeLegacyHoldMs, GoogleLegacyCadencePacer } from './googlePacing.js';

function sample(overrides: Partial<BrowserCollectionTiming> = {}): BrowserCollectionTiming {
  return {
    kind: 'primary',
    keyword: 'alpha',
    normalizedKeyword: 'alpha',
    isRoot: true,
    outcome: 'completed',
    captchaEncountered: false,
    relatedOutcome: 'ok',
    googlePacingMs: 0,
    pageCreateMs: 10,
    navigationMs: 500,
    captchaMs: 10,
    mainSurferMs: 4000,
    relatedSurferMs: 5000,
    serpParseMs: 100,
    locationParseMs: 100,
    totalMs: 5700,
    ...overrides,
  };
}

test('conservativeLegacyHoldMs compensates only root primary premount acceleration', () => {
  assert.equal(conservativeLegacyHoldMs(sample()), 4000);
  assert.equal(conservativeLegacyHoldMs(sample({ isRoot: false, relatedSurferMs: null, relatedOutcome: null })), 0);
  assert.equal(
    conservativeLegacyHoldMs(sample({ kind: 'related_only', mainSurferMs: null, serpParseMs: null, locationParseMs: null })),
    0,
  );
});

test('GoogleLegacyCadencePacer lets downstream work consume the hold before the next navigation', async () => {
  const pacer = new GoogleLegacyCadencePacer();
  const hold = pacer.observe(sample(), 10_000);
  assert.equal(hold, 4000);

  const sleeps: number[] = [];
  const waited = await pacer.wait({
    now: () => 12_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(waited, 2000);
  assert.deepEqual(sleeps, [2000]);

  const noWait = await pacer.wait({
    now: () => 14_500,
    sleep: async () => {
      throw new Error('must not sleep after the cadence floor has elapsed');
    },
  });
  assert.equal(noWait, 0);
});
