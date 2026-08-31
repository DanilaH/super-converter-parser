import type { CohortHistoricalPresenceState } from '../db/cohortHistoricalPresence.js';
import type { EntrantCohort } from '../enrichment/entrantCohort.js';
import type {
  FinalistEvidenceMatrix,
  FinalistEvidenceRow,
} from '../enrichment/finalistEvidence.js';
import type { CohortHistoricalPresenceDomain } from './cohortCollector.js';
import type { HistoricalPresenceStatus } from './types.js';

export const SAMPLED_HISTORICAL_PRESENCE_SEMANTICS =
  'bounded_sampled_web_presence_not_exact_first_seen' as const;

export type SampledHistoricalPresenceWarningCode =
  | 'SAMPLED_HISTORICAL_PRESENCE_NOT_COLLECTED'
  | 'SAMPLED_HISTORICAL_PRESENCE_NOT_ATTEMPTED'
  | 'SAMPLED_HISTORICAL_PRESENCE_OMITTED'
  | 'SAMPLED_HISTORICAL_PRESENCE_PROVIDER_UNAVAILABLE'
  | 'SAMPLED_HISTORICAL_PRESENCE_PROVIDER_ERRORS'
  | 'SAMPLED_HISTORICAL_PRESENCE_SELECTED_HISTORY_INCOMPLETE';

export type SampledHistoricalPresenceWarning = {
  code: SampledHistoricalPresenceWarningCode;
  affectedCount: number;
  denominator: number;
  message: string;
};

export type SampledHistoricalPresenceCoverage = {
  semantics: typeof SAMPLED_HISTORICAL_PRESENCE_SEMANTICS;
  uniqueEntrantDomainCount: number;
  collected: boolean;
  checkedCoverage: { numerator: number; denominator: number; ratio: number | null };
  observedPresenceCoverage: { numerator: number; denominator: number; ratio: number | null };
  omittedDomainCount: number;
  notFoundDomainCount: number;
  unavailableDomainCount: number;
  errorDomainCount: number;
  incompleteSelectedHistoryDomainCount: number;
  warnings: SampledHistoricalPresenceWarning[];
};

export type FinalistSampledHistoricalPresenceDomain = {
  registrableDomain: string;
  coverageStatus: 'checked' | 'omitted' | 'unobserved';
  omitReason: 'domain_cap' | null;
  status: HistoricalPresenceStatus | null;
  earliestSampledCaptureAt: string | null;
  earliestMatchedCollectionId: string | null;
  historyCompleteForSelectedCollections: boolean | null;
  source: string | null;
  sourceReason: string | null;
};

export type FinalistSampledHistoricalPresenceEvidence = {
  semantics: typeof SAMPLED_HISTORICAL_PRESENCE_SEMANTICS;
  collected: boolean;
  cohortDomainCount: number;
  checkedDomainCount: number;
  omittedDomainCount: number;
  unobservedDomainCount: number;
  observedPresenceCount: number;
  notFoundCount: number;
  unavailableCount: number;
  errorCount: number;
  incompleteSelectedHistoryCount: number;
  domains: FinalistSampledHistoricalPresenceDomain[];
  warnings: string[];
};

type FinalistEvidenceRowWithSampledHistory = Omit<FinalistEvidenceRow, 'evidence'> & {
  evidence: FinalistEvidenceRow['evidence'] & {
    sampledHistoricalPresence: FinalistSampledHistoricalPresenceEvidence;
  };
};

export type FinalistEvidenceMatrixWithSampledHistory = Omit<FinalistEvidenceMatrix, 'finalists'> & {
  finalists: FinalistEvidenceRowWithSampledHistory[];
};

function coverage(numerator: number, denominator: number) {
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
  };
}

function uniqueEntrantDomains(cohorts: EntrantCohort[]): string[] {
  return [...new Set(
    cohorts.flatMap((cohort) => cohort.domains.map((domain) => domain.registrableDomain)),
  )].sort((a, b) => a.localeCompare(b));
}

function assertSnapshotDomainSet(cohorts: EntrantCohort[], state: CohortHistoricalPresenceState): void {
  const expected = uniqueEntrantDomains(cohorts);
  const actual = state.collection.domains.map((domain) => domain.registrableDomain).sort((a, b) => a.localeCompare(b));
  if (expected.length !== actual.length || expected.some((domain, index) => domain !== actual[index])) {
    throw new Error('Sampled historical-presence domains do not match the current entrant cohort.');
  }
}

export function projectSampledHistoricalPresenceCoverage(input: {
  cohorts: EntrantCohort[] | null;
  state: CohortHistoricalPresenceState | null;
}): SampledHistoricalPresenceCoverage | null {
  if (input.cohorts === null) {
    if (input.state !== null) throw new Error('Sampled historical presence cannot exist without an entrant cohort.');
    return null;
  }

  const uniqueDomains = uniqueEntrantDomains(input.cohorts);
  const denominator = uniqueDomains.length;
  if (input.state === null) {
    return {
      semantics: SAMPLED_HISTORICAL_PRESENCE_SEMANTICS,
      uniqueEntrantDomainCount: denominator,
      collected: false,
      checkedCoverage: coverage(0, denominator),
      observedPresenceCoverage: coverage(0, denominator),
      omittedDomainCount: 0,
      notFoundDomainCount: 0,
      unavailableDomainCount: 0,
      errorDomainCount: 0,
      incompleteSelectedHistoryDomainCount: 0,
      warnings: denominator === 0 ? [] : [{
        code: 'SAMPLED_HISTORICAL_PRESENCE_NOT_COLLECTED',
        affectedCount: denominator,
        denominator,
        message: `Common Crawl sampled historical presence is not collected for ${denominator} unique finalist entrant domain(s). Missing sampled history is uncertainty, not evidence of recent or absent web presence.`,
      }],
    };
  }

  assertSnapshotDomainSet(input.cohorts, input.state);
  const summary = input.state.collection.summary;
  if (summary.uniqueDomainCount !== denominator) {
    throw new Error(`Sampled historical-presence denominator ${summary.uniqueDomainCount} does not match current unique entrant domains ${denominator}.`);
  }
  const notAttemptedDomainCount = input.state.collection.domains.filter(
    (domain) => domain.coverageStatus === 'checked' && domain.result?.status === 'not_attempted',
  ).length;
  const incompleteSelectedHistoryDomainCount = input.state.collection.domains.filter(
    (domain) => domain.coverageStatus === 'checked'
      && domain.result?.status === 'ok'
      && !domain.result.historyCompleteForSelectedCollections,
  ).length;
  const warnings: SampledHistoricalPresenceWarning[] = [];
  if (notAttemptedDomainCount > 0) {
    warnings.push({
      code: 'SAMPLED_HISTORICAL_PRESENCE_NOT_ATTEMPTED',
      affectedCount: notAttemptedDomainCount,
      denominator,
      message: `${notAttemptedDomainCount}/${denominator} unique finalist entrant domain(s) have sampled-history status not_attempted and remain unobserved.`,
    });
  }
  if (summary.omittedDomainCount > 0) {
    warnings.push({
      code: 'SAMPLED_HISTORICAL_PRESENCE_OMITTED',
      affectedCount: summary.omittedDomainCount,
      denominator,
      message: `${summary.omittedDomainCount}/${denominator} unique finalist entrant domain(s) were omitted by the explicit Common Crawl domain cap. Omitted domains are not negative evidence.`,
    });
  }
  if (summary.unavailableDomainCount > 0) {
    warnings.push({
      code: 'SAMPLED_HISTORICAL_PRESENCE_PROVIDER_UNAVAILABLE',
      affectedCount: summary.unavailableDomainCount,
      denominator,
      message: `${summary.unavailableDomainCount}/${denominator} unique finalist entrant domain(s) have Common Crawl provider status unavailable.`,
    });
  }
  if (summary.errorDomainCount > 0) {
    warnings.push({
      code: 'SAMPLED_HISTORICAL_PRESENCE_PROVIDER_ERRORS',
      affectedCount: summary.errorDomainCount,
      denominator,
      message: `${summary.errorDomainCount}/${denominator} unique finalist entrant domain(s) have Common Crawl provider error status.`,
    });
  }
  if (incompleteSelectedHistoryDomainCount > 0) {
    warnings.push({
      code: 'SAMPLED_HISTORICAL_PRESENCE_SELECTED_HISTORY_INCOMPLETE',
      affectedCount: incompleteSelectedHistoryDomainCount,
      denominator,
      message: `${incompleteSelectedHistoryDomainCount}/${denominator} unique finalist entrant domain(s) have an observed sampled capture but at least one earlier selected Common Crawl collection was not successfully checked. Their sampled timestamp is not a complete lower-bound observation across the selected collections.`,
    });
  }

  return {
    semantics: SAMPLED_HISTORICAL_PRESENCE_SEMANTICS,
    uniqueEntrantDomainCount: denominator,
    collected: true,
    checkedCoverage: coverage(summary.checkedDomainCount, denominator),
    observedPresenceCoverage: coverage(summary.knownPresenceDomainCount, denominator),
    omittedDomainCount: summary.omittedDomainCount,
    notFoundDomainCount: summary.notFoundDomainCount,
    unavailableDomainCount: summary.unavailableDomainCount,
    errorDomainCount: summary.errorDomainCount,
    incompleteSelectedHistoryDomainCount,
    warnings,
  };
}

function projectFinalistBlock(
  cohort: EntrantCohort,
  byDomain: ReadonlyMap<string, CohortHistoricalPresenceDomain> | null,
): FinalistSampledHistoricalPresenceEvidence {
  const domains: FinalistSampledHistoricalPresenceDomain[] = cohort.domains
    .map((entrantDomain) => {
      const sampled = byDomain?.get(entrantDomain.registrableDomain) ?? null;
      if (sampled === null) {
        return {
          registrableDomain: entrantDomain.registrableDomain,
          coverageStatus: 'unobserved' as const,
          omitReason: null,
          status: null,
          earliestSampledCaptureAt: null,
          earliestMatchedCollectionId: null,
          historyCompleteForSelectedCollections: null,
          source: null,
          sourceReason: null,
        };
      }
      return {
        registrableDomain: entrantDomain.registrableDomain,
        coverageStatus: sampled.coverageStatus,
        omitReason: sampled.omitReason,
        status: sampled.result?.status ?? null,
        earliestSampledCaptureAt: sampled.result?.earliestSampledCaptureAt ?? null,
        earliestMatchedCollectionId: sampled.result?.earliestMatchedCollectionId ?? null,
        historyCompleteForSelectedCollections: sampled.result?.historyCompleteForSelectedCollections ?? null,
        source: sampled.result?.source ?? null,
        sourceReason: sampled.result?.sourceReason ?? null,
      };
    })
    .sort((a, b) => a.registrableDomain.localeCompare(b.registrableDomain));

  const checked = domains.filter((domain) => domain.coverageStatus === 'checked');
  const omitted = domains.filter((domain) => domain.coverageStatus === 'omitted');
  const unobserved = domains.filter((domain) => domain.coverageStatus === 'unobserved');
  const observedPresence = checked.filter((domain) => domain.status === 'ok');
  const notFound = checked.filter((domain) => domain.status === 'not_found');
  const unavailable = checked.filter((domain) => domain.status === 'unavailable');
  const notAttempted = checked.filter((domain) => domain.status === 'not_attempted');
  const errors = checked.filter((domain) => domain.status === 'error');
  const incomplete = observedPresence.filter((domain) => domain.historyCompleteForSelectedCollections === false);
  const warnings = [
    'Common Crawl evidence is bounded sampled web presence, not an exact first-seen date.',
  ];
  if (unobserved.length > 0) warnings.push(`${unobserved.length}/${domains.length} cohort domain(s) have no sampled historical-presence snapshot.`);
  if (notAttempted.length > 0) warnings.push(`${notAttempted.length}/${domains.length} cohort domain(s) have sampled-history status not_attempted and remain unobserved.`);
  if (omitted.length > 0) warnings.push(`${omitted.length}/${domains.length} cohort domain(s) were omitted by the explicit sampled-history domain cap.`);
  if (notFound.length > 0) warnings.push(`${notFound.length}/${domains.length} cohort domain(s) had no capture observed in the selected Common Crawl collections; this is not proof of absence.`);
  if (unavailable.length > 0) warnings.push(`${unavailable.length}/${domains.length} cohort domain(s) have sampled-history provider status unavailable.`);
  if (errors.length > 0) warnings.push(`${errors.length}/${domains.length} cohort domain(s) have sampled-history provider errors.`);
  if (incomplete.length > 0) warnings.push(`${incomplete.length}/${domains.length} cohort domain(s) have an observed sampled capture with incomplete earlier selected-collection checking.`);

  return {
    semantics: SAMPLED_HISTORICAL_PRESENCE_SEMANTICS,
    collected: byDomain !== null,
    cohortDomainCount: domains.length,
    checkedDomainCount: checked.length,
    omittedDomainCount: omitted.length,
    unobservedDomainCount: unobserved.length + notAttempted.length,
    observedPresenceCount: observedPresence.length,
    notFoundCount: notFound.length,
    unavailableCount: unavailable.length,
    errorCount: errors.length,
    incompleteSelectedHistoryCount: incomplete.length,
    domains,
    warnings,
  };
}

export function attachSampledHistoricalPresenceToFinalistMatrix(input: {
  matrix: FinalistEvidenceMatrix;
  cohorts: EntrantCohort[];
  state: CohortHistoricalPresenceState | null;
}): FinalistEvidenceMatrixWithSampledHistory {
  if (input.state !== null) assertSnapshotDomainSet(input.cohorts, input.state);
  const cohortById = new Map(input.cohorts.map((cohort) => [cohort.clusterId, cohort]));
  const byDomain = input.state === null
    ? null
    : new Map(input.state.collection.domains.map((domain) => [domain.registrableDomain, domain]));

  return {
    ...input.matrix,
    finalists: input.matrix.finalists.map((finalist) => {
      const cohort = cohortById.get(finalist.clusterId);
      if (!cohort) throw new Error(`Missing entrant cohort for finalist ${finalist.clusterId}.`);
      return {
        ...finalist,
        evidence: {
          ...finalist.evidence,
          sampledHistoricalPresence: projectFinalistBlock(cohort, byDomain),
        },
      };
    }),
  };
}
