import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COHORT_HISTORICAL_PRESENCE_LEGACY_SELECTION_POLICY,
  COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1,
} from '../historicalPresence/cohortCollector.js';
import { resolveHistoricalPresenceSelectionPolicy } from './historicalPresenceSelectionPolicy.js';

test('fresh historical collection uses entrant-v1', () => {
  assert.equal(
    resolveHistoricalPresenceSelectionPolicy(null),
    COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1,
  );
});

test('legacy historical snapshot preserves legacy allocation on rerun', () => {
  assert.equal(
    resolveHistoricalPresenceSelectionPolicy({ collection: {} }),
    COHORT_HISTORICAL_PRESENCE_LEGACY_SELECTION_POLICY,
  );
});

test('entrant-v1 historical snapshot keeps entrant-v1 on rerun', () => {
  assert.equal(
    resolveHistoricalPresenceSelectionPolicy({
      collection: { selectionPolicyVersion: COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1 },
    }),
    COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1,
  );
});
