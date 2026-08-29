import type { DomainAgeRecord } from '../runs/domainAge.js';
import type { EntrantCohort } from './entrantCohort.js';

export const COHORT_HISTORY_PROJECTION_VERSION = '1.0.0';

export type CohortHistoryPolicy = {
  version: string;
  youngDomainMaxAgeDays: number;
  recentWebPresenceMaxAgeDays: number;
  repurposeGapMinDays: number;
};

export type HistoryCoverage = {
  numerator: number;
  denominator: number;
  ratio: number | null;
};

export type CohortDomainHistory = {
  registrableDomain: string;
  coverageStatus: 'checked' | 'omitted' | 'unobserved';
  omitReason: string | null;
  registration: {
    status: DomainAgeRecord['registrationStatus'] | 'unobserved';
    date: string | null;
    ageDays: number | null;
    isYoung: boolean | null;
    error: string | null;
    isRedacted: boolean | null;
  };
  firstSeen: {
    status: DomainAgeRecord['firstSeenStatus'] | 'unobserved';
    date: string | null;
    ageDays: number | null;
    isRecent: boolean | null;
    source: string | null;
    sourceReason: string | null;
    error: string | null;
  };
  registrationFirstSeenGapDays: number | null;
  possibleHistoryConflict: boolean | null;
  historyConflictReason:
    | 'first_seen_before_registration'
    | 'registration_long_before_first_seen'
    | null;
  observedAt: string | null;
};

export type CohortHistoryProjection = {
  clusterId: string;
  version: string;
  policy: CohortHistoryPolicy;
  domains: CohortDomainHistory[];
  summary: {
    cohortDomainCount: number;
    checkedDomainCount: number;
    omittedDomainCount: number;
    unobservedDomainCount: number;
    checkedCoverage: HistoryCoverage;
    registrationKnownDomainCount: number;
    youngDomainCount: number;
    youngDomainCoverage: HistoryCoverage;
    firstSeenKnownDomainCount: number;
    recentWebPresenceCount: number;
    recentWebPresenceCoverage: HistoryCoverage;
    comparableHistoryDomainCount: number;
    possibleHistoryConflictCount: number;
    possibleHistoryConflictCoverage: HistoryCoverage;
    registrationStatusCounts: Record<string, number>;
    firstSeenStatusCounts: Record<string, number>;
  };
};

export function projectCohortHistory(input: {
  cohorts: EntrantCohort[];
  historyRecords: DomainAgeRecord[];
  omittedDomains?: ReadonlyMap<string, string>;
  policy: CohortHistoryPolicy;
}): CohortHistoryProjection[] {
  validatePolicy(input.policy);
  const historyByDomain = new Map<string, DomainAgeRecord>();
  for (const record of input.historyRecords) {
    if (historyByDomain.has(record.domain)) {
      throw new Error(`Duplicate domain-history record for ${record.domain}`);
    }
    historyByDomain.set(record.domain, record);
  }

  const omittedDomains = input.omittedDomains ?? new Map<string, string>();
  for (const domain of omittedDomains.keys()) {
    const record = historyByDomain.get(domain);
    if (record && !record.omitted) {
      throw new Error(`Domain ${domain} cannot be both persisted history evidence and cap-omitted`);
    }
  }

  return [...input.cohorts]
    .sort((a, b) => compareClusterIds(a.clusterId, b.clusterId))
    .map((cohort) => projectCluster(cohort, historyByDomain, omittedDomains, input.policy));
}

function projectCluster(
  cohort: EntrantCohort,
  historyByDomain: ReadonlyMap<string, DomainAgeRecord>,
  omittedDomains: ReadonlyMap<string, string>,
  policy: CohortHistoryPolicy,
): CohortHistoryProjection {
  const domains = cohort.domains.map((domain) =>
    projectDomain(
      domain.registrableDomain,
      historyByDomain.get(domain.registrableDomain),
      omittedDomains.get(domain.registrableDomain),
      policy,
    ));

  const checkedDomainCount = domains.filter((domain) => domain.coverageStatus === 'checked').length;
  const omittedDomainCount = domains.filter((domain) => domain.coverageStatus === 'omitted').length;
  const unobservedDomainCount = domains.filter((domain) => domain.coverageStatus === 'unobserved').length;
  const registrationKnownDomainCount = domains.filter(
    (domain) => domain.coverageStatus === 'checked' && domain.registration.status === 'ok' && domain.registration.ageDays !== null,
  ).length;
  const youngDomainCount = domains.filter((domain) => domain.registration.isYoung === true).length;
  const firstSeenKnownDomainCount = domains.filter(
    (domain) => domain.coverageStatus === 'checked' && domain.firstSeen.status === 'ok' && domain.firstSeen.ageDays !== null,
  ).length;
  const recentWebPresenceCount = domains.filter((domain) => domain.firstSeen.isRecent === true).length;
  const comparableHistoryDomainCount = domains.filter(
    (domain) => domain.coverageStatus === 'checked' && domain.registrationFirstSeenGapDays !== null,
  ).length;
  const possibleHistoryConflictCount = domains.filter(
    (domain) => domain.possibleHistoryConflict === true,
  ).length;

  return {
    clusterId: cohort.clusterId,
    version: COHORT_HISTORY_PROJECTION_VERSION,
    policy: { ...policy },
    domains,
    summary: {
      cohortDomainCount: domains.length,
      checkedDomainCount,
      omittedDomainCount,
      unobservedDomainCount,
      checkedCoverage: ratio(checkedDomainCount, domains.length),
      registrationKnownDomainCount,
      youngDomainCount,
      youngDomainCoverage: ratio(youngDomainCount, registrationKnownDomainCount),
      firstSeenKnownDomainCount,
      recentWebPresenceCount,
      recentWebPresenceCoverage: ratio(recentWebPresenceCount, firstSeenKnownDomainCount),
      comparableHistoryDomainCount,
      possibleHistoryConflictCount,
      possibleHistoryConflictCoverage: ratio(possibleHistoryConflictCount, comparableHistoryDomainCount),
      registrationStatusCounts: countStatuses(domains.map((domain) => domain.registration.status)),
      firstSeenStatusCounts: countStatuses(domains.map((domain) => domain.firstSeen.status)),
    },
  };
}

function projectDomain(
  domain: string,
  record: DomainAgeRecord | undefined,
  reconstructedOmitReason: string | undefined,
  policy: CohortHistoryPolicy,
): CohortDomainHistory {
  if (record?.omitted) {
    return omittedDomain(domain, record.omitReason ?? 'domain_cap', {
      registrationStatus: record.registrationStatus,
      firstSeenStatus: record.firstSeenStatus,
      observedAt: record.observedAt,
    });
  }
  if (!record && reconstructedOmitReason !== undefined) {
    return omittedDomain(domain, reconstructedOmitReason);
  }
  if (!record) return unobservedDomain(domain);

  const registrationAgeDays = record.registrationStatus === 'ok'
    ? requireNonNegativeAge(record.domainAgeDays, domain, 'registration')
    : null;
  const firstSeenAgeDays = record.firstSeenStatus === 'ok'
    ? ageDaysBetween(record.firstSeenDate, record.observedAt, domain, 'first-seen')
    : null;
  const registrationFirstSeenGapDays =
    record.registrationStatus === 'ok' && record.firstSeenStatus === 'ok'
      ? dateGapDays(record.registrationDate, record.firstSeenDate, domain)
      : null;
  const historyConflictReason = historyConflictReasonFor(
    registrationFirstSeenGapDays,
    policy.repurposeGapMinDays,
  );

  return {
    registrableDomain: domain,
    coverageStatus: 'checked',
    omitReason: null,
    registration: {
      status: record.registrationStatus,
      date: record.registrationDate,
      ageDays: registrationAgeDays,
      isYoung: registrationAgeDays === null
        ? null
        : registrationAgeDays <= policy.youngDomainMaxAgeDays,
      error: record.registrationError,
      isRedacted: record.registrationIsRedacted,
    },
    firstSeen: {
      status: record.firstSeenStatus,
      date: record.firstSeenDate,
      ageDays: firstSeenAgeDays,
      isRecent: firstSeenAgeDays === null
        ? null
        : firstSeenAgeDays <= policy.recentWebPresenceMaxAgeDays,
      source: record.firstSeenSource,
      sourceReason: record.firstSeenSourceReason,
      error: record.firstSeenError,
    },
    registrationFirstSeenGapDays,
    possibleHistoryConflict: registrationFirstSeenGapDays === null
      ? null
      : historyConflictReason !== null,
    historyConflictReason,
    observedAt: record.observedAt,
  };
}

function omittedDomain(
  domain: string,
  omitReason: string,
  historical?: {
    registrationStatus: DomainAgeRecord['registrationStatus'];
    firstSeenStatus: DomainAgeRecord['firstSeenStatus'];
    observedAt: string;
  },
): CohortDomainHistory {
  return {
    registrableDomain: domain,
    coverageStatus: 'omitted',
    omitReason,
    registration: {
      status: historical?.registrationStatus ?? 'not_attempted',
      date: null,
      ageDays: null,
      isYoung: null,
      error: null,
      isRedacted: null,
    },
    firstSeen: {
      status: historical?.firstSeenStatus ?? 'not_attempted',
      date: null,
      ageDays: null,
      isRecent: null,
      source: null,
      sourceReason: null,
      error: null,
    },
    registrationFirstSeenGapDays: null,
    possibleHistoryConflict: null,
    historyConflictReason: null,
    observedAt: historical?.observedAt ?? null,
  };
}

function unobservedDomain(domain: string): CohortDomainHistory {
  return {
    registrableDomain: domain,
    coverageStatus: 'unobserved',
    omitReason: null,
    registration: {
      status: 'unobserved',
      date: null,
      ageDays: null,
      isYoung: null,
      error: null,
      isRedacted: null,
    },
    firstSeen: {
      status: 'unobserved',
      date: null,
      ageDays: null,
      isRecent: null,
      source: null,
      sourceReason: null,
      error: null,
    },
    registrationFirstSeenGapDays: null,
    possibleHistoryConflict: null,
    historyConflictReason: null,
    observedAt: null,
  };
}

function historyConflictReasonFor(
  gapDays: number | null,
  repurposeGapMinDays: number,
): CohortDomainHistory['historyConflictReason'] {
  if (gapDays === null) return null;
  if (gapDays < 0) return 'first_seen_before_registration';
  if (gapDays >= repurposeGapMinDays) return 'registration_long_before_first_seen';
  return null;
}

function requireNonNegativeAge(
  value: number | null,
  domain: string,
  label: string,
): number {
  if (value === null || !Number.isFinite(value) || value < 0) {
    throw new Error(`${domain} has invalid ${label} age evidence`);
  }
  return value;
}

function ageDaysBetween(
  date: string | null,
  observedAt: string,
  domain: string,
  label: string,
): number {
  if (!date) throw new Error(`${domain} has ${label} status ok without a date`);
  const observed = Date.parse(observedAt);
  const value = Date.parse(date);
  if (!Number.isFinite(observed) || !Number.isFinite(value) || value > observed) {
    throw new Error(`${domain} has invalid ${label} date evidence`);
  }
  return Math.floor((observed - value) / 86_400_000);
}

function dateGapDays(
  registrationDate: string | null,
  firstSeenDate: string | null,
  domain: string,
): number {
  if (!registrationDate || !firstSeenDate) {
    throw new Error(`${domain} has comparable history statuses without both dates`);
  }
  const registration = Date.parse(registrationDate);
  const firstSeen = Date.parse(firstSeenDate);
  if (!Number.isFinite(registration) || !Number.isFinite(firstSeen)) {
    throw new Error(`${domain} has invalid comparable history dates`);
  }
  return Math.floor((firstSeen - registration) / 86_400_000);
}

function countStatuses(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function ratio(numerator: number, denominator: number): HistoryCoverage {
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
  };
}

function validatePolicy(policy: CohortHistoryPolicy): void {
  if (policy.version !== COHORT_HISTORY_PROJECTION_VERSION) {
    throw new Error(
      `Unsupported cohort history policy version ${policy.version}; expected ${COHORT_HISTORY_PROJECTION_VERSION}`,
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

function compareClusterIds(a: string, b: string): number {
  const aMatch = /^cluster-(\d+)$/.exec(a);
  const bMatch = /^cluster-(\d+)$/.exec(b);
  if (aMatch && bMatch) {
    const numeric = Number(aMatch[1]) - Number(bMatch[1]);
    if (numeric !== 0) return numeric;
  }
  return a.localeCompare(b);
}
