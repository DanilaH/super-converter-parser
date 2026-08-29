import {
  COHORT_HISTORY_PROJECTION_VERSION,
  type CohortHistoryPolicy,
} from './cohortHistory.js';

export type CohortHistoryPolicyOverrides = {
  youngDomainMaxAgeDays?: number | undefined;
  recentWebPresenceMaxAgeDays?: number | undefined;
  repurposeGapMinDays?: number | undefined;
};

export function resolveCohortHistoryPolicy(input: {
  previous: CohortHistoryPolicy | null;
  overrides: CohortHistoryPolicyOverrides;
}): CohortHistoryPolicy {
  const hasOverride = Object.values(input.overrides).some((value) => value !== undefined);
  if (!hasOverride) {
    if (!input.previous) {
      throw new Error(
        'First cohort-history run requires explicit --young-domain-max-age-days, '
        + '--recent-web-presence-max-age-days and --repurpose-gap-min-days.',
      );
    }
    validatePolicy(input.previous);
    return { ...input.previous };
  }

  const youngDomainMaxAgeDays = input.overrides.youngDomainMaxAgeDays
    ?? input.previous?.youngDomainMaxAgeDays;
  const recentWebPresenceMaxAgeDays = input.overrides.recentWebPresenceMaxAgeDays
    ?? input.previous?.recentWebPresenceMaxAgeDays;
  const repurposeGapMinDays = input.overrides.repurposeGapMinDays
    ?? input.previous?.repurposeGapMinDays;

  if (
    youngDomainMaxAgeDays === undefined
    || recentWebPresenceMaxAgeDays === undefined
    || repurposeGapMinDays === undefined
  ) {
    throw new Error(
      'First cohort-history run requires all three history thresholds; partial policy has no implicit defaults.',
    );
  }

  const policy: CohortHistoryPolicy = {
    version: COHORT_HISTORY_PROJECTION_VERSION,
    youngDomainMaxAgeDays,
    recentWebPresenceMaxAgeDays,
    repurposeGapMinDays,
  };
  validatePolicy(policy);
  return policy;
}

function validatePolicy(policy: CohortHistoryPolicy): void {
  if (policy.version !== COHORT_HISTORY_PROJECTION_VERSION) {
    throw new Error(
      `Unsupported cohort history policy version ${policy.version}; expected ${COHORT_HISTORY_PROJECTION_VERSION}.`,
    );
  }
  for (const [name, value] of [
    ['youngDomainMaxAgeDays', policy.youngDomainMaxAgeDays],
    ['recentWebPresenceMaxAgeDays', policy.recentWebPresenceMaxAgeDays],
    ['repurposeGapMinDays', policy.repurposeGapMinDays],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer, got ${value}`);
    }
  }
}
