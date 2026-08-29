import { registrableDomain } from '../domains/normalize.js';
import type { EntrantCohort } from './entrantCohort.js';
import { clusteringUrlIdentity } from './urlIdentity.js';

export const TRAFFIC_EVIDENCE_VERSION = '1.0.0';

export type TrafficEntityScope = 'domain' | 'url';

export type TrafficEvidencePolicy = {
  version: string;
  lowBaseOrganicTrafficThreshold: number;
};

export type TrafficSnapshotInput = {
  targetClusterId: string;
  scope: TrafficEntityScope;
  entity: string;
  observedAt: string;
  providerDataDate: string;
  market: string;
  source: string;
  organicTraffic: number | null;
  trafficValue: number | null;
  trafficValueCurrency: string | null;
  provenance: string;
};

export type TrafficTargetValidation =
  | {
      status: 'matched';
      basis: 'registrable_domain' | 'normalized_ranking_url';
      matchedDomain: string;
      matchedRankingUrl: string | null;
      reason: null;
    }
  | {
      status: 'mismatch';
      basis: 'registrable_domain' | 'normalized_ranking_url';
      matchedDomain: string | null;
      matchedRankingUrl: null;
      reason: 'domain_not_in_target' | 'url_domain_not_in_target' | 'ranking_url_not_in_target';
    };

export type TrafficSnapshot = TrafficSnapshotInput & {
  version: string;
  normalizedEntity: string;
  targetValidation: TrafficTargetValidation;
};

export type TrafficMetricDelta = {
  previous: number;
  current: number;
  absoluteDelta: number;
  percentDelta: number | null;
};

export type TrafficVelocity = {
  fromProviderDataDate: string;
  toProviderDataDate: string;
  elapsedDays: number;
  organicTraffic: (TrafficMetricDelta & { lowBaseWarning: boolean }) | null;
  trafficValue: (TrafficMetricDelta & { currency: string }) | null;
  warnings: Array<'low_base_organic_traffic' | 'traffic_value_currency_mismatch'>;
};

export type TrafficHistory = {
  targetClusterId: string;
  scope: TrafficEntityScope;
  normalizedEntity: string;
  market: string;
  source: string;
  snapshots: TrafficSnapshot[];
  effectiveSnapshots: TrafficSnapshot[];
  sameDateRevisionCount: number;
  velocities: TrafficVelocity[];
};

export type TrafficEvidenceProjection = {
  version: string;
  policy: TrafficEvidencePolicy;
  snapshotCount: number;
  matchedSnapshotCount: number;
  mismatchedSnapshotCount: number;
  histories: TrafficHistory[];
  mismatchedSnapshots: TrafficSnapshot[];
};

export function validateTrafficEvidencePolicy(policy: TrafficEvidencePolicy): void {
  if (policy.version !== TRAFFIC_EVIDENCE_VERSION) {
    throw new Error(
      `Unsupported traffic evidence policy version ${policy.version}; expected ${TRAFFIC_EVIDENCE_VERSION}`,
    );
  }
  if (!Number.isFinite(policy.lowBaseOrganicTrafficThreshold) || policy.lowBaseOrganicTrafficThreshold < 0) {
    throw new Error(
      `lowBaseOrganicTrafficThreshold must be a non-negative finite number, got ${policy.lowBaseOrganicTrafficThreshold}`,
    );
  }
}

export function normalizeTrafficSnapshots(input: {
  rows: TrafficSnapshotInput[];
  cohorts: EntrantCohort[];
}): TrafficSnapshot[] {
  const cohortById = new Map<string, EntrantCohort>();
  for (const cohort of input.cohorts) {
    if (cohortById.has(cohort.clusterId)) {
      throw new Error(`Duplicate entrant cohort cluster ${cohort.clusterId}`);
    }
    cohortById.set(cohort.clusterId, cohort);
  }

  return input.rows.map((row, index) => normalizeTrafficSnapshot(row, index, cohortById));
}

export function projectTrafficEvidence(input: {
  snapshots: TrafficSnapshot[];
  policy: TrafficEvidencePolicy;
}): TrafficEvidenceProjection {
  validateTrafficEvidencePolicy(input.policy);
  for (const snapshot of input.snapshots) validateNormalizedSnapshot(snapshot);
  const matched = input.snapshots.filter((snapshot) => snapshot.targetValidation.status === 'matched');
  const mismatchedSnapshots = input.snapshots
    .filter((snapshot) => snapshot.targetValidation.status === 'mismatch')
    .sort(compareTrafficSnapshotsForOutput);
  return {
    version: TRAFFIC_EVIDENCE_VERSION,
    policy: { ...input.policy },
    snapshotCount: input.snapshots.length,
    matchedSnapshotCount: matched.length,
    mismatchedSnapshotCount: mismatchedSnapshots.length,
    histories: buildMatchedTrafficHistories(matched, input.policy),
    mismatchedSnapshots,
  };
}

export function buildTrafficHistories(input: {
  snapshots: TrafficSnapshot[];
  policy: TrafficEvidencePolicy;
}): TrafficHistory[] {
  validateTrafficEvidencePolicy(input.policy);
  for (const snapshot of input.snapshots) {
    validateNormalizedSnapshot(snapshot);
    if (snapshot.targetValidation.status !== 'matched') {
      throw new Error('buildTrafficHistories accepts only target-matched snapshots; use projectTrafficEvidence to retain mismatches');
    }
  }
  return buildMatchedTrafficHistories(input.snapshots, input.policy);
}

function buildMatchedTrafficHistories(
  snapshots: TrafficSnapshot[],
  policy: TrafficEvidencePolicy,
): TrafficHistory[] {
  const groups = new Map<string, TrafficSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = historyKey(snapshot);
    const rows = groups.get(key) ?? [];
    rows.push(snapshot);
    groups.set(key, rows);
  }
  return [...groups.values()]
    .map((rows) => buildTrafficHistory(rows, policy))
    .sort(compareTrafficHistories);
}

function normalizeTrafficSnapshot(
  row: TrafficSnapshotInput,
  index: number,
  cohortById: ReadonlyMap<string, EntrantCohort>,
): TrafficSnapshot {
  const label = `Traffic import row ${index + 1}`;
  if (row.targetClusterId.trim() === '') throw new Error(`${label} has empty targetClusterId`);
  const targetClusterId = row.targetClusterId.trim();
  const cohort = cohortById.get(targetClusterId);
  if (!cohort) throw new Error(`${label} references unknown finalist cluster ${targetClusterId}`);
  if (row.scope !== 'domain' && row.scope !== 'url') {
    throw new Error(`${label} has unsupported entity scope ${String(row.scope)}`);
  }

  const observedAt = canonicalDate(row.observedAt, `${label} observedAt`);
  const providerDataDate = canonicalProviderDate(row.providerDataDate, `${label} providerDataDate`);
  if (Date.parse(`${providerDataDate}T00:00:00.000Z`) > Date.parse(observedAt)) {
    throw new Error(`${label} providerDataDate cannot be after observedAt`);
  }
  const market = requiredNormalizedLabel(row.market, `${label} market`);
  const source = requiredNormalizedLabel(row.source, `${label} source`);
  const provenance = row.provenance.trim();
  if (provenance === '') throw new Error(`${label} has empty provenance`);

  assertNullableMetric(row.organicTraffic, `${label} organicTraffic`);
  assertNullableMetric(row.trafficValue, `${label} trafficValue`);
  if (row.organicTraffic === null && row.trafficValue === null) {
    throw new Error(`${label} must provide organicTraffic and/or trafficValue`);
  }

  const trafficValueCurrency = normalizeCurrency(row.trafficValueCurrency, label, row.trafficValue);
  const target = row.scope === 'domain'
    ? validateDomainTarget(row.entity, cohort, label)
    : validateUrlTarget(row.entity, cohort, label);

  return {
    version: TRAFFIC_EVIDENCE_VERSION,
    targetClusterId,
    scope: row.scope,
    entity: row.entity.trim(),
    normalizedEntity: target.normalizedEntity,
    observedAt,
    providerDataDate,
    market,
    source,
    organicTraffic: row.organicTraffic,
    trafficValue: row.trafficValue,
    trafficValueCurrency,
    provenance,
    targetValidation: target.validation,
  };
}

function validateDomainTarget(
  entity: string,
  cohort: EntrantCohort,
  label: string,
): { normalizedEntity: string; validation: TrafficTargetValidation } {
  const host = entity.trim().toLowerCase().replace(/\.$/, '');
  const normalized = registrableDomain(host);
  if (normalized === null) {
    throw new Error(`${label} domain entity must be a valid hostname, got ${entity}`);
  }
  if (host !== normalized) {
    throw new Error(
      `${label} domain scope requires a registrable domain, not subdomain/URL ${entity}; use ${normalized}`,
    );
  }
  const matched = cohort.domains.some((domain) => domain.registrableDomain === normalized);
  return {
    normalizedEntity: normalized,
    validation: matched
      ? {
          status: 'matched',
          basis: 'registrable_domain',
          matchedDomain: normalized,
          matchedRankingUrl: null,
          reason: null,
        }
      : {
          status: 'mismatch',
          basis: 'registrable_domain',
          matchedDomain: null,
          matchedRankingUrl: null,
          reason: 'domain_not_in_target',
        },
  };
}

function validateUrlTarget(
  entity: string,
  cohort: EntrantCohort,
  label: string,
): { normalizedEntity: string; validation: TrafficTargetValidation } {
  let parsed: URL;
  try {
    parsed = new URL(entity.trim());
  } catch {
    throw new Error(`${label} URL entity is invalid: ${entity}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} URL entity must use http/https: ${entity}`);
  }
  const normalized = clusteringUrlIdentity(parsed.toString());
  if (normalized === null) throw new Error(`${label} URL entity cannot be normalized safely: ${entity}`);

  const occurrence = cohort.occurrences.find((row) => row.normalizedPageIdentity === normalized);
  if (occurrence) {
    return {
      normalizedEntity: normalized,
      validation: {
        status: 'matched',
        basis: 'normalized_ranking_url',
        matchedDomain: occurrence.registrableDomain,
        matchedRankingUrl: occurrence.rankingUrl,
        reason: null,
      },
    };
  }

  const domain = registrableDomain(parsed.hostname);
  const domainIsEntrant = domain !== null
    && cohort.domains.some((row) => row.registrableDomain === domain);
  return {
    normalizedEntity: normalized,
    validation: {
      status: 'mismatch',
      basis: 'normalized_ranking_url',
      matchedDomain: domainIsEntrant ? domain : null,
      matchedRankingUrl: null,
      reason: domainIsEntrant ? 'ranking_url_not_in_target' : 'url_domain_not_in_target',
    },
  };
}

function buildTrafficHistory(
  inputSnapshots: TrafficSnapshot[],
  policy: TrafficEvidencePolicy,
): TrafficHistory {
  const snapshots = [...inputSnapshots].sort(compareTrafficSnapshots);
  const byProviderDate = new Map<string, TrafficSnapshot[]>();
  for (const snapshot of snapshots) {
    const revisions = byProviderDate.get(snapshot.providerDataDate) ?? [];
    revisions.push(snapshot);
    byProviderDate.set(snapshot.providerDataDate, revisions);
  }

  const effectiveSnapshots = [...byProviderDate.values()]
    .map(selectEffectiveRevision)
    .sort(compareTrafficSnapshots);
  const sameDateRevisionCount = snapshots.length - effectiveSnapshots.length;
  const velocities: TrafficVelocity[] = [];
  for (let index = 1; index < effectiveSnapshots.length; index += 1) {
    const previous = effectiveSnapshots[index - 1]!;
    const current = effectiveSnapshots[index]!;
    velocities.push(trafficVelocity(previous, current, policy));
  }
  const first = snapshots[0]!;
  return {
    targetClusterId: first.targetClusterId,
    scope: first.scope,
    normalizedEntity: first.normalizedEntity,
    market: first.market,
    source: first.source,
    snapshots,
    effectiveSnapshots,
    sameDateRevisionCount,
    velocities,
  };
}

function selectEffectiveRevision(revisions: TrafficSnapshot[]): TrafficSnapshot {
  const ordered = [...revisions].sort(compareTrafficSnapshots);
  const latestObservedAt = ordered.at(-1)!.observedAt;
  const latest = ordered.filter((snapshot) => snapshot.observedAt === latestObservedAt);
  if (latest.length > 1) {
    const fingerprints = new Set(latest.map(effectiveRevisionFingerprint));
    if (fingerprints.size > 1) {
      const first = latest[0]!;
      throw new Error(
        `Ambiguous traffic revisions for ${first.targetClusterId} ${first.scope} ${first.normalizedEntity}: `
        + `providerDataDate ${first.providerDataDate} has conflicting snapshots at observedAt ${latestObservedAt}`,
      );
    }
  }
  return latest[0]!;
}

function effectiveRevisionFingerprint(snapshot: TrafficSnapshot): string {
  return JSON.stringify({
    organicTraffic: snapshot.organicTraffic,
    trafficValue: snapshot.trafficValue,
    trafficValueCurrency: snapshot.trafficValueCurrency,
  });
}

function trafficVelocity(
  previous: TrafficSnapshot,
  current: TrafficSnapshot,
  policy: TrafficEvidencePolicy,
): TrafficVelocity {
  const elapsedDays = Math.floor(
    (Date.parse(`${current.providerDataDate}T00:00:00.000Z`)
      - Date.parse(`${previous.providerDataDate}T00:00:00.000Z`)) / 86_400_000,
  );
  if (elapsedDays <= 0) throw new Error('Traffic velocity requires increasing provider data dates');

  const warnings: TrafficVelocity['warnings'] = [];
  const organicTraffic = previous.organicTraffic !== null && current.organicTraffic !== null
    ? {
        ...metricDelta(previous.organicTraffic, current.organicTraffic),
        lowBaseWarning: previous.organicTraffic <= policy.lowBaseOrganicTrafficThreshold,
      }
    : null;
  if (organicTraffic?.lowBaseWarning) warnings.push('low_base_organic_traffic');

  let trafficValue: TrafficVelocity['trafficValue'] = null;
  if (previous.trafficValue !== null && current.trafficValue !== null) {
    if (
      previous.trafficValueCurrency !== null
      && current.trafficValueCurrency !== null
      && previous.trafficValueCurrency === current.trafficValueCurrency
    ) {
      trafficValue = {
        ...metricDelta(previous.trafficValue, current.trafficValue),
        currency: current.trafficValueCurrency,
      };
    } else {
      warnings.push('traffic_value_currency_mismatch');
    }
  }

  return {
    fromProviderDataDate: previous.providerDataDate,
    toProviderDataDate: current.providerDataDate,
    elapsedDays,
    organicTraffic,
    trafficValue,
    warnings,
  };
}

function metricDelta(previous: number, current: number): TrafficMetricDelta {
  const absoluteDelta = current - previous;
  return {
    previous,
    current,
    absoluteDelta,
    percentDelta: previous === 0 ? null : (absoluteDelta / previous) * 100,
  };
}

function validateNormalizedSnapshot(snapshot: TrafficSnapshot): void {
  if (snapshot.version !== TRAFFIC_EVIDENCE_VERSION) {
    throw new Error(`Unsupported traffic snapshot version ${snapshot.version}`);
  }
  if (snapshot.targetClusterId.trim() === '' || snapshot.targetClusterId !== snapshot.targetClusterId.trim()) {
    throw new Error('Traffic snapshot has invalid targetClusterId');
  }
  if (snapshot.scope !== 'domain' && snapshot.scope !== 'url') {
    throw new Error(`Traffic snapshot has unsupported scope ${String(snapshot.scope)}`);
  }
  if (snapshot.entity.trim() === '' || snapshot.entity !== snapshot.entity.trim()) {
    throw new Error('Traffic snapshot has invalid entity');
  }
  if (canonicalDate(snapshot.observedAt, 'traffic snapshot observedAt') !== snapshot.observedAt) {
    throw new Error('Traffic snapshot observedAt is not canonical ISO time');
  }
  if (canonicalProviderDate(snapshot.providerDataDate, 'traffic snapshot providerDataDate') !== snapshot.providerDataDate) {
    throw new Error('Traffic snapshot providerDataDate is not canonical YYYY-MM-DD');
  }
  if (Date.parse(`${snapshot.providerDataDate}T00:00:00.000Z`) > Date.parse(snapshot.observedAt)) {
    throw new Error('Traffic snapshot providerDataDate cannot be after observedAt');
  }
  if (requiredNormalizedLabel(snapshot.market, 'traffic snapshot market') !== snapshot.market) {
    throw new Error('Traffic snapshot market is not normalized');
  }
  if (requiredNormalizedLabel(snapshot.source, 'traffic snapshot source') !== snapshot.source) {
    throw new Error('Traffic snapshot source is not normalized');
  }
  if (snapshot.provenance.trim() === '' || snapshot.provenance !== snapshot.provenance.trim()) {
    throw new Error('Traffic snapshot has invalid provenance');
  }
  assertNullableMetric(snapshot.organicTraffic, 'traffic snapshot organicTraffic');
  assertNullableMetric(snapshot.trafficValue, 'traffic snapshot trafficValue');
  if (snapshot.organicTraffic === null && snapshot.trafficValue === null) {
    throw new Error('Traffic snapshot has no measured traffic metric');
  }
  const normalizedCurrency = normalizeCurrency(
    snapshot.trafficValueCurrency,
    'traffic snapshot',
    snapshot.trafficValue,
  );
  if (normalizedCurrency !== snapshot.trafficValueCurrency) {
    throw new Error('Traffic snapshot currency is not normalized');
  }
  if (normalizedEntityForSnapshot(snapshot) !== snapshot.normalizedEntity) {
    throw new Error('Traffic snapshot normalized entity does not match raw entity/scope');
  }
  validateTargetValidation(snapshot);
}

function validateTargetValidation(snapshot: TrafficSnapshot): void {
  const validation = snapshot.targetValidation;
  if (validation.status === 'matched') {
    if (validation.reason !== null) throw new Error('Matched traffic snapshot cannot carry mismatch reason');
    if (validation.basis === 'registrable_domain') {
      if (
        snapshot.scope !== 'domain'
        || validation.matchedDomain !== snapshot.normalizedEntity
        || validation.matchedRankingUrl !== null
      ) {
        throw new Error('Matched domain traffic validation is inconsistent');
      }
      return;
    }
    if (snapshot.scope !== 'url' || validation.matchedRankingUrl === null) {
      throw new Error('Matched URL traffic validation is incomplete');
    }
    const rankingIdentity = clusteringUrlIdentity(validation.matchedRankingUrl);
    if (rankingIdentity !== snapshot.normalizedEntity) {
      throw new Error('Matched URL traffic validation points at a different ranking page');
    }
    const entityDomain = domainForUrl(snapshot.entity);
    if (entityDomain === null || validation.matchedDomain !== entityDomain) {
      throw new Error('Matched URL traffic validation has inconsistent domain ownership');
    }
    return;
  }

  if (validation.reason === null) throw new Error('Mismatched traffic snapshot must carry a validation reason');
  if (validation.matchedRankingUrl !== null) {
    throw new Error('Mismatched traffic snapshot cannot claim a matched ranking URL');
  }
  if (validation.basis === 'registrable_domain') {
    if (
      snapshot.scope !== 'domain'
      || validation.reason !== 'domain_not_in_target'
      || validation.matchedDomain !== null
    ) {
      throw new Error('Mismatched domain traffic validation is inconsistent');
    }
    return;
  }
  if (snapshot.scope !== 'url' || validation.reason === 'domain_not_in_target') {
    throw new Error('Mismatched URL traffic validation is inconsistent');
  }
  const entityDomain = domainForUrl(snapshot.entity);
  if (validation.reason === 'url_domain_not_in_target') {
    if (validation.matchedDomain !== null) {
      throw new Error('Foreign-domain URL mismatch cannot claim entrant domain ownership');
    }
    return;
  }
  if (entityDomain === null || validation.matchedDomain !== entityDomain) {
    throw new Error('Same-domain URL mismatch has inconsistent domain ownership');
  }
}

function normalizedEntityForSnapshot(snapshot: TrafficSnapshot): string {
  if (snapshot.scope === 'domain') {
    const host = snapshot.entity.toLowerCase().replace(/\.$/, '');
    const normalized = registrableDomain(host);
    if (normalized === null || host !== normalized) {
      throw new Error('Traffic snapshot domain entity is not a registrable domain');
    }
    return normalized;
  }
  let parsed: URL;
  try {
    parsed = new URL(snapshot.entity);
  } catch {
    throw new Error('Traffic snapshot URL entity is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Traffic snapshot URL entity must use http/https');
  }
  const normalized = clusteringUrlIdentity(parsed.toString());
  if (normalized === null) throw new Error('Traffic snapshot URL entity cannot be normalized safely');
  return normalized;
}

function domainForUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return registrableDomain(parsed.hostname);
  } catch {
    return null;
  }
}

function historyKey(snapshot: TrafficSnapshot): string {
  return [
    snapshot.targetClusterId,
    snapshot.scope,
    snapshot.normalizedEntity,
    snapshot.market,
    snapshot.source,
  ].join('\u0000');
}

function compareTrafficSnapshots(a: TrafficSnapshot, b: TrafficSnapshot): number {
  return a.providerDataDate.localeCompare(b.providerDataDate)
    || Date.parse(a.observedAt) - Date.parse(b.observedAt)
    || a.provenance.localeCompare(b.provenance);
}

export function compareTrafficSnapshotsForOutput(a: TrafficSnapshot, b: TrafficSnapshot): number {
  return compareClusterIds(a.targetClusterId, b.targetClusterId)
    || a.scope.localeCompare(b.scope)
    || a.normalizedEntity.localeCompare(b.normalizedEntity)
    || a.market.localeCompare(b.market)
    || a.source.localeCompare(b.source)
    || compareTrafficSnapshots(a, b)
    || a.entity.localeCompare(b.entity)
    || compareNullableNumbers(a.organicTraffic, b.organicTraffic)
    || compareNullableNumbers(a.trafficValue, b.trafficValue)
    || (a.trafficValueCurrency ?? '').localeCompare(b.trafficValueCurrency ?? '')
    || a.targetValidation.basis.localeCompare(b.targetValidation.basis)
    || (a.targetValidation.matchedDomain ?? '').localeCompare(b.targetValidation.matchedDomain ?? '')
    || (a.targetValidation.matchedRankingUrl ?? '').localeCompare(b.targetValidation.matchedRankingUrl ?? '')
    || (a.targetValidation.reason ?? '').localeCompare(b.targetValidation.reason ?? '');
}

function compareNullableNumbers(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

function compareTrafficHistories(a: TrafficHistory, b: TrafficHistory): number {
  return compareClusterIds(a.targetClusterId, b.targetClusterId)
    || a.scope.localeCompare(b.scope)
    || a.normalizedEntity.localeCompare(b.normalizedEntity)
    || a.market.localeCompare(b.market)
    || a.source.localeCompare(b.source);
}

function canonicalDate(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date/time, got ${value}`);
  return new Date(parsed).toISOString();
}

function canonicalProviderDate(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`${label} must use YYYY-MM-DD, got ${value}`);
  }
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${label} must be a real calendar date, got ${value}`);
  }
  return normalized;
}

function requiredNormalizedLabel(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') throw new Error(`${label} cannot be empty`);
  return normalized;
}

function assertNullableMetric(value: number | null, label: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must be null or a non-negative finite number, got ${String(value)}`);
  }
}

function normalizeCurrency(
  currency: string | null,
  label: string,
  trafficValue: number | null,
): string | null {
  if (trafficValue === null) {
    if (currency !== null && currency.trim() !== '') {
      throw new Error(`${label} trafficValueCurrency requires trafficValue`);
    }
    return null;
  }
  if (currency === null || !/^[A-Za-z]{3}$/.test(currency.trim())) {
    throw new Error(`${label} trafficValue requires a three-letter currency code`);
  }
  return currency.trim().toUpperCase();
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
