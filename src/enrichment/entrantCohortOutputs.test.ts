import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntrantCohort } from './entrantCohort.js';
import {
  writeEntrantCohortDomainsCsv,
  writeEntrantCohortJson,
  writeEntrantCohortOccurrencesCsv,
} from './entrantCohortOutputs.js';

const COHORT: EntrantCohort = {
  clusterId: 'cluster-1',
  representativeKeywordIds: [17, 20],
  representativeQueryCount: 2,
  version: '1.0.0',
  serpTopN: 10,
  occurrences: [
    {
      keywordIdx: 17,
      position: 1,
      rankingUrl: 'https://example.test/tool?utm_source=a',
      registrableDomain: 'example.test',
      normalizedPageIdentity: 'example.test/tool',
      dr: 20,
    },
    {
      keywordIdx: 20,
      position: 3,
      rankingUrl: 'https://example.test/tool',
      registrableDomain: 'example.test',
      normalizedPageIdentity: 'example.test/tool',
      dr: 20,
    },
  ],
  excludedOccurrences: [{
    keywordIdx: 20,
    position: 10,
    rankingUrl: 'https://localhost/tool',
    reason: 'no_registrable_domain',
  }],
  domains: [{
    registrableDomain: 'example.test',
    occurrences: [],
    occurrenceCount: 2,
    bestRank: 1,
    medianRank: 2,
    queryIdsPresent: [17, 20],
    queryCoverage: { numerator: 2, denominator: 2, ratio: 1 },
    rankingUrls: [
      'https://example.test/tool?utm_source=a',
      'https://example.test/tool',
    ],
    normalizedPageIdentities: ['example.test/tool'],
    pageIdentityCoverage: { numerator: 2, denominator: 2, ratio: 1 },
    samePageRepetition: {
      repeatedAcrossQueries: true,
      repeatedPageCount: 1,
      maxQueriesPerPage: 2,
    },
    sameDomainDifferentPageRepetition: {
      repeatedAcrossQueries: false,
      distinctPageCount: 1,
    },
    drEvidence: {
      status: 'known',
      value: 20,
      observedValues: [20],
      knownOccurrenceCount: 2,
      occurrenceCount: 2,
      isWeak: true,
    },
  }],
  summary: {
    observedOccurrenceCount: 2,
    excludedOccurrenceCount: 1,
    uniqueDomainCount: 1,
    pageIdentityCoverage: { numerator: 2, denominator: 2, ratio: 1 },
    knownDrDomainCount: 1,
    missingDrDomainCount: 0,
    conflictingDrDomainCount: 0,
    weakDomainCount: 1,
    weakDomainCoverage: { numerator: 1, denominator: 1, ratio: 1 },
    repeatedDomainCount: 1,
    repeatedDomainCoverage: { numerator: 1, denominator: 1, ratio: 1 },
    samePageRepeatedDomainCount: 1,
    differentPageRepeatedDomainCount: 0,
  },
  warnings: ['survivorship warning'],
};

const THRESHOLDS = {
  veryWeakMax: 10,
  weakMax: 30,
  strongMin: 60,
  strongMax: 75,
};

const SOURCE_UPDATED_AT = '2026-08-29T10:00:00.000Z';
const CLUSTERING_UPDATED_AT = '2026-08-29T10:05:00.000Z';

test('domain CSV exposes rank, query/page denominators, repetition and DR coverage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-domains-'));
  try {
    const path = join(directory, 'entrant-cohort.csv');
    await writeEntrantCohortDomainsCsv(path, [COHORT]);
    const csv = await readFile(path, 'utf8');
    assert.match(csv, /query_coverage_numerator,query_coverage_denominator/);
    assert.match(csv, /page_identity_coverage_numerator,page_identity_coverage_denominator,page_identity_coverage_ratio/);
    assert.match(csv, /known_dr_occurrences,dr_occurrence_denominator/);
    assert.match(csv, /cluster-1,example\.test,1,2,2,2,17;20,2,2,1/);
    assert.match(csv, /example\.test\/tool,2,2,1,true,1,2,false,1,known,20,20,2,2,true/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('occurrence CSV preserves included and excluded top-10 rows explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-occurrences-'));
  try {
    const path = join(directory, 'entrant-cohort-occurrences.csv');
    await writeEntrantCohortOccurrencesCsv(path, [COHORT]);
    const csv = await readFile(path, 'utf8');
    assert.match(csv, /17,1,https:\/\/example\.test\/tool\?utm_source=a,example\.test,example\.test\/tool,20,true,/);
    assert.match(csv, /20,10,https:\/\/localhost\/tool,,,,false,no_registrable_domain/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('JSON pins representative revision, source generation, DR thresholds, top-N and survivorship warning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-json-'));
  try {
    const path = join(directory, 'entrant-cohort.json');
    await writeEntrantCohortJson(path, {
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      representativeRevision: 3,
      sourceRunUpdatedAt: SOURCE_UPDATED_AT,
      clusteringUpdatedAt: CLUSTERING_UPDATED_AT,
      drThresholds: THRESHOLDS,
      cohorts: [COHORT],
    });
    const json = JSON.parse(await readFile(path, 'utf8')) as {
      representativeRevision: number;
      sourceRunUpdatedAt: string;
      clusteringUpdatedAt: string;
      drThresholds: typeof THRESHOLDS;
      cohortVersion: string;
      serpTopN: number;
      cohorts: EntrantCohort[];
    };
    assert.equal(json.representativeRevision, 3);
    assert.equal(json.sourceRunUpdatedAt, SOURCE_UPDATED_AT);
    assert.equal(json.clusteringUpdatedAt, CLUSTERING_UPDATED_AT);
    assert.deepEqual(json.drThresholds, THRESHOLDS);
    assert.equal(json.cohortVersion, '1.0.0');
    assert.equal(json.serpTopN, 10);
    assert.deepEqual(json.cohorts[0]?.warnings, ['survivorship warning']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
