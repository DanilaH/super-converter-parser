import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import {
  DEFAULT_GOOGLE_MIN_NAVIGATION_INTERVAL_MS,
  GoogleNavigationGate,
} from './googleNavigationGate.js';

test('default gate uses the conservative 2s burst floor', () => {
  assert.equal(DEFAULT_GOOGLE_MIN_NAVIGATION_INTERVAL_MS, 2_000);
  assert.doesNotThrow(() => new GoogleNavigationGate());
});

test('first collection starts immediately and next collection waits only the remaining floor', async () => {
  let nowMs = 1_000;
  const sleeps: number[] = [];
  const gate = new GoogleNavigationGate(2_000);
  const params = {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    isCancelled: () => false,
  };

  assert.equal(await gate.waitForTurn(params), 0);
  nowMs += 750;
  assert.equal(await gate.waitForTurn(params), 1_250);
  assert.equal(sleeps.reduce((sum, value) => sum + value, 0), 1_250);

  nowMs += 2_500;
  assert.equal(await gate.waitForTurn(params), 0);
});

test('zero interval disables pacing for isolated unit use', async () => {
  let nowMs = 1_000;
  const gate = new GoogleNavigationGate(0);
  const sleep = async () => {
    throw new Error('disabled gate must not sleep');
  };

  assert.equal(await gate.waitForTurn({ now: () => nowMs, sleep, isCancelled: () => false }), 0);
  nowMs += 1;
  assert.equal(await gate.waitForTurn({ now: () => nowMs, sleep, isCancelled: () => false }), 0);
});

test('cancellation while pacing surfaces RUN_PAUSED', async () => {
  let nowMs = 1_000;
  let cancelled = false;
  const gate = new GoogleNavigationGate(2_000);
  const now = () => nowMs;

  await gate.waitForTurn({ now, sleep: async () => undefined, isCancelled: () => false });

  await assert.rejects(
    gate.waitForTurn({
      now,
      sleep: async (ms) => {
        nowMs += ms;
        cancelled = true;
      },
      isCancelled: () => cancelled,
    }),
    (error: unknown) => error instanceof ResearchError && error.code === 'RUN_PAUSED',
  );
});
