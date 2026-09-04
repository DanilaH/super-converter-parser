import type { EntrantCohort } from '../enrichment/entrantCohort.js';
import type { HistoricalPresenceCache } from './cache.js';
import {
  ttlMsForHistoricalPresenceStatus,
  type HistoricalPresenceClient,
  type HistoricalPresenceResult,
  type HistoricalPresenceStatus,
} from './types.js';

export const COHORT_HISTORICAL_PRESENCE_VERSION = '1.0.0';
export const COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1 = 'entrant-v1';
export const COHORT_HISTORICAL_PRESENCE_LEGACY_SELECTION_POLICY = 'legacy-rank-v1';
export const DEFAULT_COHORT_HISTORICAL_PRESENCE_DOMAIN_CAP = 30;

type CollectorSelectionPolicy =
  | typeof COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1
  | typeof COHORT_HISTORICAL_PRESENCE_LEGACY_SELECTION_POLICY;

export type CohortHistoricalPresenceDomain = {
  registrableDomain: string;
  coverageStatus: 'checked' | 'omitted';
  omitReason: 'domain_cap' | null;
  priority: {
    bestRank: number;
    occurrenceCount: number;
    clusterCount: number;
    queryCount?: number;
    distinctPageCount?: number;
    drStatus?: 'known' | 'missing' | 'conflict';
    dr?: number | null;
    isWeak?: boolean | null;
  };
  cacheStatus: 'hit' | 'miss' | 'expired' | 'identity_mismatch' | 'omitted';
  result: HistoricalPresenceResult | null;
};

export type CohortHistoricalPresenceCollection = {
  version: string;
  selectionPolicyVersion?: typeof COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1;
  domainCap: number;
  domains: CohortHistoricalPresenceDomain[];
  summary: {
    uniqueDomainCount: number;
    checkedDomainCount: number;
    omittedDomainCount: number;
    knownPresenceDomainCount: number;
    notFoundDomainCount: number;
    unavailableDomainCount: number;
    errorDomainCount: number;
    completeSelectedHistoryDomainCount: number;
    cacheHitCount: number;
    networkRequestCount: number;
    statusCounts: Record<string, number>;
  };
};

type DomainPriority = {
  registrableDomain: string;
  bestRank: number;
  occurrenceCount: number;
  clusterIds: Set<string>;
  queryIds: Set<number>;
  pageIdentities: Set<string>;
  drValues: Set<number>;
  weakValues: Set<boolean>;
};

function isFresh(expiresAt: string, nowMs: number): boolean {
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed > nowMs;
}

export async function collectCohortHistoricalPresence(input: {
  cohorts: EntrantCohort[];
  client: HistoricalPresenceClient;
  cache: HistoricalPresenceCache;
  domainCap?: number;
  selectionPolicyVersion?: CollectorSelectionPolicy;
  now?: () => number;
}): Promise<CohortHistoricalPresenceCollection> {
  const domainCap = input.domainCap ?? DEFAULT_COHORT_HISTORICAL_PRESENCE_DOMAIN_CAP;
  if (!Number.isInteger(domainCap) || domainCap < 1 || domainCap > 100) {
    throw new Error(`Historical-presence domain cap must be an integer from 1 to 100; got ${domainCap}.`);
  }
  const selectionPolicyVersion = input.selectionPolicyVersion ?? COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1;
  const entrantAware = selectionPolicyVersion === COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1;
  const now = input.now ?? Date.now;
  const nowMs = now();
  const priorities = buildDomainPriorities(input.cohorts).sort(
    entrantAware ? compareDomainPriority : compareLegacyDomainPriority,
  );
  const selected = entrantAware
    ? selectDomainPrioritiesAcrossClusters(input.cohorts, priorities, domainCap)
    : new Set(priorities.slice(0, domainCap).map((item) => item.registrableDomain));
  const domains: CohortHistoricalPresenceDomain[] = [];

  for (const priority of priorities) {
    const publishedPriority = entrantAware ? publicPriority(priority) : legacyPublicPriority(priority);
    if (!selected.has(priority.registrableDomain)) {
      domains.push({
        registrableDomain: priority.registrableDomain,
        coverageStatus: 'omitted',
        omitReason: 'domain_cap',
        priority: publishedPriority,
        cacheStatus: 'omitted',
        result: null,
      });
      continue;
    }

    const cached = input.cache.get(priority.registrableDomain);
    const identityMatches = cached !== null
      && cached.source === input.client.source
      && cached.queryVersion === input.client.queryVersion;
    const fresh = identityMatches && cached !== null && isFresh(cached.expiresAt, nowMs);

    if (fresh && cached !== null) {
      domains.push({
        registrableDomain: priority.registrableDomain,
        coverageStatus: 'checked',
        omitReason: null,
        priority: publishedPriority,
        cacheStatus: 'hit',
        result: cachedResult(cached),
      });
      continue;
    }

    const result = await input.client.lookup(priority.registrableDomain);
    input.cache.put(
      result,
      input.client.queryVersion,
      new Date(now()).toISOString(),
      ttlMsForHistoricalPresenceStatus(result.status),
    );
    domains.push({
      registrableDomain: priority.registrableDomain,
      coverageStatus: 'checked',
      omitReason: null,
      priority: publishedPriority,
      cacheStatus: cached === null ? 'miss' : identityMatches ? 'expired' : 'identity_mismatch',
      result,
    });
  }

  domains.sort((a, b) => a.registrableDomain.localeCompare(b.registrableDomain));
  return {
    version: COHORT_HISTORICAL_PRESENCE_VERSION,
    ...(entrantAware ? { selectionPolicyVersion: COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1 } : {}),
    domainCap,
    domains,
    summary: summarize(domains),
  };
}

function buildDomainPriorities(cohorts: EntrantCohort[]): DomainPriority[] {
  const byDomain = new Map<string, DomainPriority>();
  for (const cohort of [...cohorts].sort((a, b) => compareClusterIds(a.clusterId, b.clusterId))) {
    for (const domain of cohort.domains) {
      const existing = byDomain.get(domain.registrableDomain) ?? {
        registrableDomain: domain.registrableDomain,
        bestRank: Number.POSITIVE_INFINITY,
        occurrenceCount: 0,
        clusterIds: new Set<string>(),
        queryIds: new Set<number>(),
        pageIdentities: new Set<string>(),
        drValues: new Set<number>(),
        weakValues: new Set<boolean>(),
      };
      existing.bestRank = Math.min(existing.bestRank, domain.bestRank);
      existing.occurrenceCount += domain.occurrenceCount;
      existing.clusterIds.add(cohort.clusterId);
      for (const queryId of domain.queryIdsPresent) existing.queryIds.add(queryId);
      for (const pageIdentity of domain.normalizedPageIdentities) existing.pageIdentities.add(pageIdentity);
      for (const dr of domain.drEvidence.observedValues) {
        if (Number.isFinite(dr)) existing.drValues.add(dr);
      }
      if (domain.drEvidence.isWeak !== null) existing.weakValues.add(domain.drEvidence.isWeak);
      byDomain.set(domain.registrableDomain, existing);
    }
  }
  return [...byDomain.values()];
}

function selectDomainPrioritiesAcrossClusters(
  cohorts: EntrantCohort[],
  priorities: DomainPriority[],
  domainCap: number,
): Set<string> {
  const priorityByDomain = new Map(priorities.map((priority) => [priority.registrableDomain, priority]));
  const orderedCohorts = [...cohorts].sort((a, b) => compareClusterIds(a.clusterId, b.clusterId));
  const fairCohortOrder = spreadAcrossCohortOrder(orderedCohorts, domainCap);
  const candidatesByCluster = new Map<string, DomainPriority[]>();

  for (const cohort of fairCohortOrder) {
    const candidates = cohort.domains
      .map((domain) => priorityByDomain.get(domain.registrableDomain))
      .filter((priority): priority is DomainPriority => priority !== undefined)
      .sort(compareDomainPriority);
    candidatesByCluster.set(cohort.clusterId, candidates);
  }

  const selected = new Set<string>();
  const cursors = new Map(fairCohortOrder.map((cohort) => [cohort.clusterId, 0]));

  while (selected.size < domainCap) {
    let advanced = false;
    for (const cohort of fairCohortOrder) {
      const candidates = candidatesByCluster.get(cohort.clusterId) ?? [];
      let cursor = cursors.get(cohort.clusterId) ?? 0;
      while (cursor < candidates.length && selected.has(candidates[cursor]!.registrableDomain)) cursor += 1;
      cursors.set(cohort.clusterId, cursor + 1);
      const candidate = candidates[cursor];
      if (!candidate) continue;
      selected.add(candidate.registrableDomain);
      advanced = true;
      if (selected.size >= domainCap) break;
    }
    if (!advanced) break;
  }

  return selected;
}

function spreadAcrossCohortOrder(cohorts: EntrantCohort[], domainCap: number): EntrantCohort[] {
  if (cohorts.length <= domainCap) return cohorts;

  const sampledIndices = new Set<number>();
  for (let slot = 0; slot < domainCap; slot += 1) {
    sampledIndices.add(Math.floor((slot * cohorts.length) / domainCap));
  }

  return [
    ...[...sampledIndices].map((index) => cohorts[index]!),
    ...cohorts.filter((_, index) => !sampledIndices.has(index)),
  ];
}

function compareLegacyDomainPriority(a: DomainPriority, b: DomainPriority): number {
  return a.bestRank - b.bestRank
    || b.clusterIds.size - a.clusterIds.size
    || b.occurrenceCount - a.occurrenceCount
    || a.registrableDomain.localeCompare(b.registrableDomain);
}

function compareDomainPriority(a: DomainPriority, b: DomainPriority): number {
  const aPublic = publicPriority(a);
  const bPublic = publicPriority(b);
  const weakTier = Number(bPublic.isWeak === true) - Number(aPublic.isWeak === true);
  if (weakTier !== 0) return weakTier;
  if ((bPublic.clusterCount ?? 0) !== (aPublic.clusterCount ?? 0)) return (bPublic.clusterCount ?? 0) - (aPublic.clusterCount ?? 0);
  if ((bPublic.queryCount ?? 0) !== (aPublic.queryCount ?? 0)) return (bPublic.queryCount ?? 0) - (aPublic.queryCount ?? 0);
  if ((bPublic.distinctPageCount ?? 0) !== (aPublic.distinctPageCount ?? 0)) return (bPublic.distinctPageCount ?? 0) - (aPublic.distinctPageCount ?? 0);
  if (aPublic.bestRank !== bPublic.bestRank) return aPublic.bestRank - bPublic.bestRank;
  if (bPublic.occurrenceCount !== aPublic.occurrenceCount) return bPublic.occurrenceCount - aPublic.occurrenceCount;
  const aDr = aPublic.drStatus === 'known' && aPublic.dr !== null && aPublic.dr !== undefined ? aPublic.dr : Number.POSITIVE_INFINITY;
  const bDr = bPublic.drStatus === 'known' && bPublic.dr !== null && bPublic.dr !== undefined ? bPublic.dr : Number.POSITIVE_INFINITY;
  if (aDr !== bDr) return aDr - bDr;
  return a.registrableDomain.localeCompare(b.registrableDomain);
}

function legacyPublicPriority(priority: DomainPriority): CohortHistoricalPresenceDomain['priority'] {
  return {
    bestRank: priority.bestRank,
    occurrenceCount: priority.occurrenceCount,
    clusterCount: priority.clusterIds.size,
  };
}

function publicPriority(priority: DomainPriority): CohortHistoricalPresenceDomain['priority'] {
  const drValues = [...priority.drValues].sort((a, b) => a - b);
  const drStatus: 'known' | 'missing' | 'conflict' = drValues.length === 0
    ? 'missing'
    : drValues.length === 1
      ? 'known'
      : 'conflict';
  const weakValues = [...priority.weakValues];
  const isWeak = drStatus === 'known' && weakValues.length === 1 ? weakValues[0]! : null;
  return {
    bestRank: priority.bestRank,
    occurrenceCount: priority.occurrenceCount,
    clusterCount: priority.clusterIds.size,
    queryCount: priority.queryIds.size,
    distinctPageCount: priority.pageIdentities.size,
    drStatus,
    dr: drStatus === 'known' ? drValues[0]! : null,
    isWeak,
  };
}

function cachedResult(cached: ReturnType<HistoricalPresenceCache['get']> & {}): HistoricalPresenceResult {
  return {
    domain: cached.domain,
    status: cached.status,
    earliestSampledCaptureAt: cached.earliestSampledCaptureAt,
    earliestSampledCaptureUrl: cached.earliestSampledCaptureUrl,
    earliestSampledCaptureHttpStatus: cached.earliestSampledCaptureHttpStatus,
    earliestMatchedCollectionId: cached.earliestMatchedCollectionId,
    earliestMatchedCollectionFrom: cached.earliestMatchedCollectionFrom,
    earliestMatchedCollectionTo: cached.earliestMatchedCollectionTo,
    historyCompleteForSelectedCollections: cached.historyCompleteForSelectedCollections,
    selectedCollectionCount: cached.selectedCollectionCount,
    checkedCollectionCount: cached.checkedCollectionCount,
    source: cached.source,
    sourceReason: cached.sourceReason,
    error: cached.error,
    fetchedAt: cached.fetchedAt,
    requestCount: cached.requestCount,
    httpStatus: cached.httpStatus,
  };
}

function summarize(domains: CohortHistoricalPresenceDomain[]): CohortHistoricalPresenceCollection['summary'] {
  const checked = domains.filter((domain) => domain.coverageStatus === 'checked');
  const statusCounts: Record<string, number> = {};
  for (const domain of checked) {
    const status = domain.result?.status ?? 'not_attempted';
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  const statusCount = (status: HistoricalPresenceStatus): number => statusCounts[status] ?? 0;
  return {
    uniqueDomainCount: domains.length,
    checkedDomainCount: checked.length,
    omittedDomainCount: domains.length - checked.length,
    knownPresenceDomainCount: statusCount('ok'),
    notFoundDomainCount: statusCount('not_found'),
    unavailableDomainCount: statusCount('unavailable'),
    errorDomainCount: statusCount('error'),
    completeSelectedHistoryDomainCount: checked.filter(
      (domain) => domain.result?.status === 'ok' && domain.result.historyCompleteForSelectedCollections,
    ).length,
    cacheHitCount: checked.filter((domain) => domain.cacheStatus === 'hit').length,
    networkRequestCount: checked
      .filter((domain) => domain.cacheStatus !== 'hit')
      .reduce((sum, domain) => sum + (domain.result?.requestCount ?? 0), 0),
    statusCounts,
  };
}

function compareClusterIds(a: string, b: string): number {
  const aMatch = /^cluster-(\d+)$/.exec(a);
  const bMatch = /^cluster-(\d+)$/.exec(b);
  if (aMatch && bMatch) {
    const diff = Number(aMatch[1]) - Number(bMatch[1]);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}
