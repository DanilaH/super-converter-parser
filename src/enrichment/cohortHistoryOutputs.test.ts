import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CohortHistorySnapshot } from '../db/cohortHistory.js';
import {
  COHORT_HISTORY_PROJECTION_VERSION,
  type CohortHistoryProjection,
} from './cohortHistory.js';
import {
  writeCohortHistoryDomainsCsv,
  writeCohortHistoryJson,
  writeCohortHistorySummaryCsv,
} from './cohortHistoryOutputs.js';

const policy = {
  version: COHORT_HISTORY_PROJECTION_VERSION,
  youngDomainMaxAgeDays: 365,
  recentWebPresenceMaxAgeDays: 180,
  repurposeGapMinDays: 1_000,
};

const projection: CohortHistoryProjection = {
  clusterId: 'cluster-1',
  version: COHORT_HISTORY_PROJECTION_VERSION,
  policy,
  domains: [{
    registrableDomain: 'example.test',
    coverageStatus: 'checked',
    omitReason: null,
    registration: {
      status: 'ok',
      date: '2026-06-01T00:00:00.000Z',
      ageDays: 89,
      isYoung: true,
      error: null,
      isRedacted: false,
    },
    firstSeen: {
      status: 'unavailable',
      date: null,
      ageDays: null,
      isRecent: null,
      source: 'unconfigured',
      sourceReason: 'provider_not_configured',
      error: null,
    },
    registrationFirstSeenGapDays: null,
    possibleHistoryConflict: null,
    historyConflictReason: null,
    observedAt: '2026-08-29T00:00:00.000Z',
  }],
  summary: {
    cohortDomainCount: 1,
    checkedDomainCount: 1,
    omittedDomainCount: 0,
    unobservedDomainCount: 0,
    checkedCoverage: { numerator: 1, denominator: 1, ratio: 1 },
    registrationKnownDomainCount: 1,
    youngDomainCount: 1,
    youngDomainCoverage: { numerator: 1, denominator: 1, ratio: 1 },
    firstSeenKnownDomainCount: 0,
    recentWebPresenceCount: 0,
    recentWebPresenceCoverage: { numerator: 0, denominator: 0, ratio: null },
    comparableHistoryDomainCount: 0,
    possibleHistoryConflictCount: 0,
    possibleHistoryConflictCoverage: { numerator: 0, denominator: 0, ratio: null },
    registrationStatusCounts: { ok: 1 },
    firstSeenStatusCounts: { unavailable: 1 },
  },
};

test('cohort history CSVs expose domain facts and ratio denominators explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cohort-history-outputs-'));
  try {
    const domainsPath = join(directory, 'domains.csv');
    const summaryPath = join(directory, 'summary.csv');
    await writeCohortHistoryDomainsCsv(domainsPath, [projection]);
    await writeCohortHistorySummaryCsv(summaryPath, [projection]);

    const domains = await readFile(domainsPath, 'utf8');
    assert.match(domains, /registration_age_days/);
    assert.match(domains, /first_seen_source_reason/);
    assert.match(domains, /example\.test/);
    assert.match(domains, /provider_not_configured/);

    const summary = await readFile(summaryPath, 'utf8');
    assert.match(summary, /checked_coverage_numerator,checked_coverage_denominator,checked_coverage_ratio/);
    assert.match(summary, /young_coverage_numerator,young_coverage_denominator,young_coverage_ratio/);
    assert.match(summary, /recent_web_presence_numerator,recent_web_presence_denominator,recent_web_presence_ratio/);
    assert.match(summary, /history_conflict_numerator,history_conflict_denominator,history_conflict_ratio/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cohort history JSON preserves exact policy and parent fingerprint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cohort-history-json-'));
  try {
    const outputPath = join(directory, 'history.json');
    const snapshot: CohortHistorySnapshot = {
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      entrantRepresentativeRevision: 2,
      entrantFingerprint: 'a'.repeat(64),
      projectionVersion: COHORT_HISTORY_PROJECTION_VERSION,
      policy,
      projections: [projection],
    };
    await writeCohortHistoryJson(outputPath, snapshot);
    const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as CohortHistorySnapshot;
    assert.deepEqual(parsed.policy, policy);
    assert.equal(parsed.entrantFingerprint, 'a'.repeat(64));
    assert.equal(parsed.projections[0]?.summary.recentWebPresenceCoverage.denominator, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
