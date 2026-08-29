import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCohortHistorySourceFreshness } from './cohortHistorySourceFreshness.js';

test('cohort history accepts the exact entrant source generation', () => {
  assert.doesNotThrow(() => assertCohortHistorySourceFreshness({
    sourceRunId: 'source-1',
    currentSourceUpdatedAt: '2026-08-29T10:00:00.000Z',
    entrantSourceUpdatedAt: '2026-08-29T10:00:00.000Z',
  }));
});

test('cohort history rejects any changed source generation', () => {
  assert.throws(
    () => assertCohortHistorySourceFreshness({
      sourceRunId: 'source-1',
      currentSourceUpdatedAt: '2026-08-29T10:01:00.000Z',
      entrantSourceUpdatedAt: '2026-08-29T10:00:00.000Z',
    }),
    /changed after the persisted entrant-cohort snapshot/,
  );
});
