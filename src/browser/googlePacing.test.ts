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

test('GoogleLegacyCadencePacer pays the full budget even after downstream work elapsed', async () => {
  const pacer = new GoogleLegacyCadencePacer();
  const hold = pacer.observe(sample(), 10_000);
  assert.equal(hold, 4000);

  const sleeps: number[] = [];
  const waited = await pacer.wait({
    now: () => 99_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(waited, 4000);
  assert.deepEqual(sleeps, [4000]);

  const noWait = await pacer.wait({
    now: () => 100_000,
    sleep: async () => {
      throw new Error('budget must be consumed exactly once');
    },
  });
  assert.equal(noWait, 0);
});
