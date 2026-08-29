import test from 'node:test';
import assert from 'node:assert/strict';
import type { EntrantCohort } from './entrantCohort.js';
import {
  TRAFFIC_EVIDENCE_VERSION,
  buildTrafficHistories,
  normalizeTrafficSnapshots,
  projectTrafficEvidence,
  type TrafficSnapshotInput,
} from './trafficEvidence.js';

function cohort(): EntrantCohort {
  const occurrence = {
    keywordIdx: 1,
    position: 1,
    rankingUrl: 'https://example.test/tool?utm_source=serp',
    registrableDomain: 'example.test',
    normalizedPageIdentity: 'example.test/tool',
    dr: 20,
  };
  return {
    clusterId: 'cluster-1',
    representativeKeywordIds: [1],
    representativeQueryCount: 1,
    version: '1.0.0',
    serpTopN: 10,
    occurrences: [occurrence],
    excludedOccurrences: [],
    domains: [{
      registrableDomain: 'example.test',
      occurrences: [occurrence],
      occurrenceCount: 1,
      bestRank: 1,
      medianRank: 1,
      queryIdsPresent: [1],
      queryCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      rankingUrls: [occurrence.rankingUrl],
      normalizedPageIdentities: ['example.test/tool'],
      pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      samePageRepetition: { repeatedAcrossQueries: false, repeatedPageCount: 0, maxQueriesPerPage: 1 },
      sameDomainDifferentPageRepetition: { repeatedAcrossQueries: false, distinctPageCount: 1 },
      drEvidence: {
        status: 'known',
        value: 20,
        observedValues: [20],
        knownOccurrenceCount: 1,
        occurrenceCount: 1,
        isWeak: true,
      },
    }],
    summary: {
      observedOccurrenceCount: 1,
      excludedOccurrenceCount: 0,
      uniqueDomainCount: 1,
      pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      knownDrDomainCount: 1,
      missingDrDomainCount: 0,
      conflictingDrDomainCount: 0,
      weakDomainCount: 1,
      weakDomainCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      repeatedDomainCount: 0,
      repeatedDomainCoverage: { numerator: 0, denominator: 1, ratio: 0 },
      samePageRepeatedDomainCount: 0,
      differentPageRepeatedDomainCount: 0,
    },
    warnings: [],
  };
}

function row(overrides: Partial<TrafficSnapshotInput> = {}): TrafficSnapshotInput {
  return {
    targetClusterId: 'cluster-1',
    scope: 'domain',
    entity: 'EXAMPLE.TEST',
    observedAt: '2026-08-29T12:00:00.000Z',
    providerDataDate: '2026-08-28',
    market: 'US',
    source: 'Manual-Semrush',
    organicTraffic: 100,
    trafficValue: 250,
    trafficValueCurrency: 'usd',
    provenance: 'manual-import.csv row 2',
    ...overrides,
  };
}

const POLICY = {
  version: TRAFFIC_EVIDENCE_VERSION,
  lowBaseOrganicTrafficThreshold: 100,
};

test('domain traffic validates against the finalist registrable-domain cohort', () => {
  const [snapshot] = normalizeTrafficSnapshots({ rows: [row()], cohorts: [cohort()] });
  assert.equal(snapshot?.normalizedEntity, 'example.test');
  assert.equal(snapshot?.market, 'us');
  assert.equal(snapshot?.source, 'manual-semrush');
  assert.equal(snapshot?.trafficValueCurrency, 'USD');
  assert.deepEqual(snapshot?.targetValidation, {
    status: 'matched',
    basis: 'registrable_domain',
    matchedDomain: 'example.test',
    matchedRankingUrl: null,
    reason: null,
  });
});

test('domain scope refuses subdomain broadening but retains non-entrant target mismatch for audit', () => {
  assert.throws(
    () => normalizeTrafficSnapshots({
      rows: [row({ entity: 'blog.example.test' })],
      cohorts: [cohort()],
    }),
    /requires a registrable domain, not subdomain\/URL/,
  );

  const [snapshot] = normalizeTrafficSnapshots({
    rows: [row({ entity: 'other.test' })],
    cohorts: [cohort()],
  });
  assert.deepEqual(snapshot?.targetValidation, {
    status: 'mismatch',
    basis: 'registrable_domain',
    matchedDomain: null,
    matchedRankingUrl: null,
    reason: 'domain_not_in_target',
  });
  const projection = projectTrafficEvidence({ snapshots: [snapshot!], policy: POLICY });
  assert.equal(projection.matchedSnapshotCount, 0);
  assert.equal(projection.mismatchedSnapshotCount, 1);
  assert.equal(projection.histories.length, 0);
  assert.equal(projection.mismatchedSnapshots[0]?.normalizedEntity, 'other.test');
});

test('URL traffic validates a ranking page and audits same-domain or foreign-page mismatches separately', () => {
  const [snapshot] = normalizeTrafficSnapshots({
    rows: [row({
      scope: 'url',
      entity: 'https://www.example.test/tool?utm_campaign=x',
    })],
    cohorts: [cohort()],
  });
  assert.equal(snapshot?.normalizedEntity, 'example.test/tool');
  assert.deepEqual(snapshot?.targetValidation, {
    status: 'matched',
    basis: 'normalized_ranking_url',
    matchedDomain: 'example.test',
    matchedRankingUrl: 'https://example.test/tool?utm_source=serp',
    reason: null,
  });

  const [sameDomainMismatch, foreignDomainMismatch] = normalizeTrafficSnapshots({
    rows: [
      row({ scope: 'url', entity: 'https://example.test/other' }),
      row({ scope: 'url', entity: 'https://other.test/tool' }),
    ],
    cohorts: [cohort()],
  });
  assert.equal(sameDomainMismatch?.targetValidation.status, 'mismatch');
  assert.equal(sameDomainMismatch?.targetValidation.reason, 'ranking_url_not_in_target');
  assert.equal(sameDomainMismatch?.targetValidation.matchedDomain, 'example.test');
  assert.equal(foreignDomainMismatch?.targetValidation.status, 'mismatch');
  assert.equal(foreignDomainMismatch?.targetValidation.reason, 'url_domain_not_in_target');
  assert.equal(foreignDomainMismatch?.targetValidation.matchedDomain, null);
});

test('unknown finalist cluster remains invalid input rather than an auditable target mismatch', () => {
  assert.throws(
    () => normalizeTrafficSnapshots({
      rows: [row({ targetClusterId: 'cluster-999' })],
      cohorts: [cohort()],
    }),
    /references unknown finalist cluster cluster-999/,
  );
});

test('domain and URL snapshots remain separate histories even for the same site', () => {
  const snapshots = normalizeTrafficSnapshots({
    rows: [
      row({ trafficValue: null, trafficValueCurrency: null }),
      row({
        scope: 'url',
        entity: 'https://example.test/tool',
        trafficValue: null,
        trafficValueCurrency: null,
      }),
    ],
    cohorts: [cohort()],
  });
  const histories = buildTrafficHistories({ snapshots, policy: POLICY });
  assert.equal(histories.length, 2);
  assert.deepEqual(histories.map((history) => history.scope), ['domain', 'url']);
});

test('matched-only history builder refuses mismatches so domain evidence cannot leak into velocity', () => {
  const [snapshot] = normalizeTrafficSnapshots({
    rows: [row({ entity: 'other.test' })],
    cohorts: [cohort()],
  });
  assert.throws(
    () => buildTrafficHistories({ snapshots: [snapshot!], policy: POLICY }),
    /accepts only target-matched snapshots/,
  );
});

test('traffic rows require measured evidence and explicit currency for value evidence', () => {
  assert.throws(
    () => normalizeTrafficSnapshots({
      rows: [row({ organicTraffic: null, trafficValue: null, trafficValueCurrency: null })],
      cohorts: [cohort()],
    }),
    /must provide organicTraffic and\/or trafficValue/,
  );
  assert.throws(
    () => normalizeTrafficSnapshots({
      rows: [row({ trafficValue: 100, trafficValueCurrency: null })],
      cohorts: [cohort()],
    }),
    /requires a three-letter currency code/,
  );
  assert.throws(
    () => normalizeTrafficSnapshots({
      rows: [row({ trafficValue: null, trafficValueCurrency: 'USD' })],
      cohorts: [cohort()],
    }),
    /trafficValueCurrency requires trafficValue/,
  );
});

test('provider data date is a strict calendar date and cannot be after observation', () => {
  assert.throws(
    () => normalizeTrafficSnapshots({
      rows: [row({ providerDataDate: '2026-08-28T12:00:00Z' })],
      cohorts: [cohort()],
    }),
    /providerDataDate must use YYYY-MM-DD/,
  );
  assert.throws(
    () => normalizeTrafficSnapshots({
      rows: [row({ providerDataDate: '2026-02-30' })],
      cohorts: [cohort()],
    }),
    /providerDataDate must be a real calendar date/,
  );
  assert.throws(
    () => normalizeTrafficSnapshots({
      rows: [row({
        observedAt: '2026-08-29T00:00:00.000Z',
        providerDataDate: '2026-08-30',
      })],
      cohorts: [cohort()],
    }),
    /providerDataDate cannot be after observedAt/,
  );
});

test('compatible history derives transparent percentage velocity and low-base warning', () => {
  const snapshots = normalizeTrafficSnapshots({
    rows: [
      row({
        observedAt: '2026-07-02T00:00:00.000Z',
        providerDataDate: '2026-07-01',
        organicTraffic: 50,
        trafficValue: 100,
      }),
      row({
        observedAt: '2026-08-02T00:00:00.000Z',
        providerDataDate: '2026-08-01',
        organicTraffic: 100,
        trafficValue: 150,
      }),
    ],
    cohorts: [cohort()],
  });
  const [history] = buildTrafficHistories({ snapshots, policy: POLICY });
  assert.equal(history?.effectiveSnapshots.length, 2);
  assert.equal(history?.velocities.length, 1);
  assert.deepEqual(history?.velocities[0]?.organicTraffic, {
    previous: 50,
    current: 100,
    absoluteDelta: 50,
    percentDelta: 100,
    lowBaseWarning: true,
  });
  assert.deepEqual(history?.velocities[0]?.trafficValue, {
    previous: 100,
    current: 150,
    absoluteDelta: 50,
    percentDelta: 50,
    currency: 'USD',
  });
  assert.deepEqual(history?.velocities[0]?.warnings, ['low_base_organic_traffic']);
});

test('zero traffic base does not fabricate an infinite percent delta', () => {
  const snapshots = normalizeTrafficSnapshots({
    rows: [
      row({
        observedAt: '2026-07-02T00:00:00.000Z',
        providerDataDate: '2026-07-01',
        organicTraffic: 0,
        trafficValue: null,
        trafficValueCurrency: null,
      }),
      row({
        observedAt: '2026-08-02T00:00:00.000Z',
        providerDataDate: '2026-08-01',
        organicTraffic: 10,
        trafficValue: null,
        trafficValueCurrency: null,
      }),
    ],
    cohorts: [cohort()],
  });
  const velocity = buildTrafficHistories({ snapshots, policy: POLICY })[0]?.velocities[0];
  assert.equal(velocity?.organicTraffic?.percentDelta, null);
  assert.equal(velocity?.organicTraffic?.absoluteDelta, 10);
  assert.equal(velocity?.organicTraffic?.lowBaseWarning, true);
});

test('traffic value currency mismatch blocks only the value delta', () => {
  const snapshots = normalizeTrafficSnapshots({
    rows: [
      row({
        observedAt: '2026-07-02T00:00:00.000Z',
        providerDataDate: '2026-07-01',
        organicTraffic: 500,
        trafficValue: 100,
        trafficValueCurrency: 'USD',
      }),
      row({
        observedAt: '2026-08-02T00:00:00.000Z',
        providerDataDate: '2026-08-01',
        organicTraffic: 600,
        trafficValue: 120,
        trafficValueCurrency: 'EUR',
      }),
    ],
    cohorts: [cohort()],
  });
  const velocity = buildTrafficHistories({ snapshots, policy: POLICY })[0]?.velocities[0];
  assert.equal(velocity?.organicTraffic?.absoluteDelta, 100);
  assert.equal(velocity?.organicTraffic?.percentDelta, 20);
  assert.equal(velocity?.trafficValue, null);
  assert.deepEqual(velocity?.warnings, ['traffic_value_currency_mismatch']);
});

test('same provider data date retains revisions but uses the latest observation for velocity', () => {
  const snapshots = normalizeTrafficSnapshots({
    rows: [
      row({
        observedAt: '2026-07-02T00:00:00.000Z',
        providerDataDate: '2026-07-01',
        organicTraffic: 100,
      }),
      row({
        observedAt: '2026-07-03T00:00:00.000Z',
        providerDataDate: '2026-07-01',
        organicTraffic: 120,
        provenance: 'corrected import row',
      }),
      row({
        observedAt: '2026-08-02T00:00:00.000Z',
        providerDataDate: '2026-08-01',
        organicTraffic: 180,
      }),
    ],
    cohorts: [cohort()],
  });
  const [history] = buildTrafficHistories({ snapshots, policy: POLICY });
  assert.equal(history?.snapshots.length, 3);
  assert.equal(history?.effectiveSnapshots.length, 2);
  assert.equal(history?.sameDateRevisionCount, 1);
  assert.equal(history?.effectiveSnapshots[0]?.organicTraffic, 120);
  assert.equal(history?.velocities[0]?.organicTraffic?.absoluteDelta, 60);
  assert.equal(history?.velocities[0]?.organicTraffic?.percentDelta, 50);
});

test('conflicting measurements with identical provider date and observed timestamp fail loudly', () => {
  const snapshots = normalizeTrafficSnapshots({
    rows: [
      row({
        observedAt: '2026-07-02T00:00:00.000Z',
        providerDataDate: '2026-07-01',
        organicTraffic: 100,
        provenance: 'import A',
      }),
      row({
        observedAt: '2026-07-02T00:00:00.000Z',
        providerDataDate: '2026-07-01',
        organicTraffic: 120,
        provenance: 'import B',
      }),
    ],
    cohorts: [cohort()],
  });
  assert.throws(
    () => buildTrafficHistories({ snapshots, policy: POLICY }),
    /Ambiguous traffic revisions.*conflicting snapshots/,
  );
});

test('same measured revision with different provenance is not ambiguous', () => {
  const snapshots = normalizeTrafficSnapshots({
    rows: [
      row({
        observedAt: '2026-07-02T00:00:00.000Z',
        providerDataDate: '2026-07-01',
        organicTraffic: 100,
        provenance: 'export row',
      }),
      row({
        observedAt: '2026-07-02T00:00:00.000Z',
        providerDataDate: '2026-07-01',
        organicTraffic: 100,
        provenance: 'screenshot confirmation',
      }),
    ],
    cohorts: [cohort()],
  });
  const [history] = buildTrafficHistories({ snapshots, policy: POLICY });
  assert.equal(history?.snapshots.length, 2);
  assert.equal(history?.effectiveSnapshots.length, 1);
  assert.equal(history?.sameDateRevisionCount, 1);
  assert.equal(history?.effectiveSnapshots[0]?.organicTraffic, 100);
});

test('byte-identical duplicate snapshot does not create an ambiguous effective revision', () => {
  const duplicate = row({
    observedAt: '2026-07-02T00:00:00.000Z',
    providerDataDate: '2026-07-01',
    organicTraffic: 100,
  });
  const snapshots = normalizeTrafficSnapshots({
    rows: [duplicate, { ...duplicate }],
    cohorts: [cohort()],
  });
  const [history] = buildTrafficHistories({ snapshots, policy: POLICY });
  assert.equal(history?.snapshots.length, 2);
  assert.equal(history?.effectiveSnapshots.length, 1);
  assert.equal(history?.sameDateRevisionCount, 1);
});

test('market and source boundaries prevent incompatible snapshots from forming velocity', () => {
  const snapshots = normalizeTrafficSnapshots({
    rows: [
      row({ providerDataDate: '2026-07-01', observedAt: '2026-07-02', market: 'US', source: 'provider-a' }),
      row({ providerDataDate: '2026-08-01', observedAt: '2026-08-02', market: 'UK', source: 'provider-a' }),
      row({ providerDataDate: '2026-09-01', observedAt: '2026-09-02', market: 'US', source: 'provider-b' }),
    ],
    cohorts: [cohort()],
  });
  const histories = buildTrafficHistories({ snapshots, policy: POLICY });
  assert.equal(histories.length, 3);
  assert.equal(histories.every((history) => history.velocities.length === 0), true);
});
