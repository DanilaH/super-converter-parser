import {
  COHORT_HISTORICAL_PRESENCE_LEGACY_SELECTION_POLICY,
  COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1,
} from '../historicalPresence/cohortCollector.js';

export type HistoricalPresenceSelectionSnapshot = {
  collection: {
    selectionPolicyVersion?: typeof COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1;
  };
};

export function resolveHistoricalPresenceSelectionPolicy(
  existingSnapshot: HistoricalPresenceSelectionSnapshot | null,
): typeof COHORT_HISTORICAL_PRESENCE_LEGACY_SELECTION_POLICY | typeof COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1 {
  return existingSnapshot && existingSnapshot.collection.selectionPolicyVersion === undefined
    ? COHORT_HISTORICAL_PRESENCE_LEGACY_SELECTION_POLICY
    : COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1;
}
