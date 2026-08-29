import test from 'node:test';
import assert from 'node:assert/strict';
import { COHORT_HISTORY_PROJECTION_VERSION } from './cohortHistory.js';
import { resolveCohortHistoryPolicy } from './cohortHistoryConfig.js';

const previous = {
  version: COHORT_HISTORY_PROJECTION_VERSION,
  youngDomainMaxAgeDays: 365,
  recentWebPresenceMaxAgeDays: 180,
  repurposeGapMinDays: 1_000,
};

test('first history run refuses hidden defaults', () => {
  assert.throws(
    () => resolveCohortHistoryPolicy({ previous: null, overrides: {} }),
    /First cohort-history run requires explicit/,
  );
  assert.throws(
    () => resolveCohortHistoryPolicy({
      previous: null,
      overrides: { youngDomainMaxAgeDays: 365 },
    }),
    /partial policy has no implicit defaults/,
  );
});

test('rerun can reuse persisted policy exactly', () => {
  assert.deepEqual(
    resolveCohortHistoryPolicy({ previous, overrides: {} }),
    previous,
  );
});

test('rerun may explicitly override one threshold while preserving persisted peers', () => {
  assert.deepEqual(
    resolveCohortHistoryPolicy({
      previous,
      overrides: { recentWebPresenceMaxAgeDays: 90 },
    }),
    { ...previous, recentWebPresenceMaxAgeDays: 90 },
  );
});

test('policy rejects negative or non-integer thresholds', () => {
  assert.throws(
    () => resolveCohortHistoryPolicy({
      previous,
      overrides: { repurposeGapMinDays: -1 },
    }),
    /repurposeGapMinDays must be a non-negative integer/,
  );
  assert.throws(
    () => resolveCohortHistoryPolicy({
      previous,
      overrides: { youngDomainMaxAgeDays: 1.5 },
    }),
    /youngDomainMaxAgeDays must be a non-negative integer/,
  );
});
