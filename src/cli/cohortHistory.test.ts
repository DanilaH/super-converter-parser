import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { loadCohortHistoryState } from '../db/cohortHistory.js';
import {
  saveEntrantCohortSnapshot,
  type EntrantCohortSnapshot,
} from '../db/entrantCohorts.js';
import { saveRepresentativeQuerySnapshot } from '../db/representativeSets.js';
import { RunStore } from '../db/store.js';
import { writeEntrantCohortJson } from '../enrichment/entrantCohortOutputs.js';
import type { DomainAgeRecord } from '../runs/domainAge.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import {
  writeEnrichmentIndex,
  writeRunIndex,
} from '../outputs/researchLayout.js';

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/cohortHistory.ts', ...args],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function serpRow(keyword: string) {
  return {
    keyword,
    position: 1,
    title: 'repeat',
    url: 'https://repeat.test/tool',
    hostname: 'repeat.test',
    registrableDomain: 'repeat.test',
    dr: 20,
    drStatus: 'ok' as const,
    drError: null,
    resultType: 'organic' as const,
  };
}

async function prepareFixture(root: string) {
  const researchDirectory = join(root, '2026-08-29-history-test');
  const discoveryDirectory = join(researchDirectory, 'discovery');
  const enrichmentDirectory = join(researchDirectory, 'enrichment');
  await mkdir(discoveryDirectory, { recursive: true });
  await mkdir(enrichmentDirectory, { recursive: true });

  const sourceRunId = 'source-history';
  const enrichmentId = 'enr-history';
  const sourceStore = RunStore.open(join(discoveryDirectory, 'run.sqlite'));
  const sourceConfig = loadConfig({});
  const keywords = buildSeedKeywords([
    { keyword: 'speaker test', rowNumber: 1 },
    { keyword: 'audio test', rowNumber: 2 },
  ]);
  sourceStore.createRun({
    runId: sourceRunId,
    configSnapshot: sourceConfig,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/test.csv' },
    keywords,
  });
  sourceStore.replaceSerpRows(sourceRunId, 0, [serpRow('speaker test')]);
  sourceStore.replaceSerpRows(sourceRunId, 1, [serpRow('audio test')]);
  sourceStore.setRunState(sourceRunId, 'completed', { updatedAt: '2026-08-29T10:00:00.000Z' });
  sourceStore.close();

  const enrichmentStore = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['clusters', 'domain_age'],
    config: JSON.stringify({ shortlist: ['speaker test', 'audio test'] }),
    sourceRunDirectory: discoveryDirectory,
    enrichmentDirectory,
    shortlistKeywords: ['speaker test', 'audio test'],
  });
  enrichmentStore.setEnrichmentState(enrichmentId, 'completed');
  saveRepresentativeQuerySnapshot(
    enrichmentStore,
    enrichmentId,
    {
      targetCount: 5,
      overrides: [],
      setVersion: '1.0.0',
      selectedClusterIds: ['cluster-1'],
    },
    [{
      clusterId: 'cluster-1',
      setVersion: '1.0.0',
      representativeKeywordIds: [0, 1],
      representatives: [
        {
          keywordIdx: 0,
          keyword: 'speaker test',
          normalizedKeyword: 'speaker test',
          volume: 100,
          selectionReason: 'medoid',
          coverageGain: 1,
        },
        {
          keywordIdx: 1,
          keyword: 'audio test',
          normalizedKeyword: 'audio test',
          volume: 200,
          selectionReason: 'high_demand',
          coverageGain: 0,
        },
      ],
      targetCount: 2,
      clusterUrlCount: 1,
      coveredUrlCount: 1,
      manualOverride: false,
      manualOverrideReason: null,
    }],
  );

  const occurrence0 = {
    keywordIdx: 0,
    position: 1,
    rankingUrl: 'https://repeat.test/tool',
    registrableDomain: 'repeat.test',
    normalizedPageIdentity: 'repeat.test/tool',
    dr: 20,
  };
  const occurrence1 = { ...occurrence0, keywordIdx: 1 };
  const entrant: EntrantCohortSnapshot = {
    enrichmentId,
    sourceRunId,
    representativeRevision: 1,
    cohortVersion: '1.0.0',
    serpTopN: 10,
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
    sourceRunUpdatedAt: '2026-08-29T10:00:00.000Z',
    clusteringUpdatedAt: '2026-08-29T09:55:00.000Z',
    cohorts: [{
      clusterId: 'cluster-1',
      representativeKeywordIds: [0, 1],
      representativeQueryCount: 2,
      version: '1.0.0',
      serpTopN: 10,
      occurrences: [occurrence0, occurrence1],
      excludedOccurrences: [],
      domains: [{
        registrableDomain: 'repeat.test',
        occurrences: [occurrence0, occurrence1],
        occurrenceCount: 2,
        bestRank: 1,
        medianRank: 1,
        queryIdsPresent: [0, 1],
        queryCoverage: { numerator: 2, denominator: 2, ratio: 1 },
        rankingUrls: ['https://repeat.test/tool'],
        normalizedPageIdentities: ['repeat.test/tool'],
        pageIdentityCoverage: { numerator: 2, denominator: 2, ratio: 1 },
        samePageRepetition: { repeatedAcrossQueries: true, repeatedPageCount: 1, maxQueriesPerPage: 2 },
        sameDomainDifferentPageRepetition: { repeatedAcrossQueries: false, distinctPageCount: 1 },
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
        excludedOccurrenceCount: 0,
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
      warnings: ['observed winners only'],
    }],
  };
  saveEntrantCohortSnapshot(enrichmentStore, entrant);

  const history: DomainAgeRecord = {
    domain: 'repeat.test',
    registrationDate: '2026-06-01T00:00:00.000Z',
    registrationStatus: 'ok',
    registrationRule: 'earliest registration event',
    registrationIsRedacted: false,
    registrationFetchedAt: '2026-08-29T10:10:00.000Z',
    registrationSource: 'rdap',
    registrationEvents: [{ eventAction: 'registration', eventDate: '2026-06-01T00:00:00.000Z' }],
    firstSeenDate: '2026-07-01T00:00:00.000Z',
    firstSeenStatus: 'ok',
    firstSeenSource: 'wayback',
    firstSeenFetchedAt: '2026-08-29T10:10:00.000Z',
    sourceKeywords: ['speaker test', 'audio test'],
    sourceRanks: [{ keyword: 'speaker test', position: 1 }, { keyword: 'audio test', position: 1 }],
    domainAgeDays: 89,
    observedAt: '2026-08-29T00:00:00.000Z',
    cacheHit: false,
    cacheStatus: 'miss',
    omitted: false,
    omitReason: null,
    fetchedAt: '2026-08-29T10:10:00.000Z',
    registrationError: null,
    firstSeenError: null,
    firstSeenSourceReason: null,
    registrationHttpStatus: 200,
    registrationRequestCount: 1,
    firstSeenHttpStatus: 200,
    firstSeenRequestCount: 1,
    error: null,
  };
  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'repeat.test',
    module: 'domain_age',
    status: 'completed',
    source: 'rdap',
    cacheStatus: 'miss',
    fetchedAt: history.fetchedAt,
    payload: JSON.stringify(history),
  });
  enrichmentStore.close();

  await writeRunIndex(root, { version: 1, runId: sourceRunId, researchDirectory, discoveryDirectory });
  await writeEnrichmentIndex(root, { version: 1,
    enrichmentId,
    runId: sourceRunId,
    researchDirectory,
    enrichmentDirectory,
  });

  await writeEntrantCohortJson(join(enrichmentDirectory, 'entrant-cohort.json'), {
    enrichmentId,
    sourceRunId,
    representativeRevision: entrant.representativeRevision,
    sourceRunUpdatedAt: entrant.sourceRunUpdatedAt,
    clusteringUpdatedAt: entrant.clusteringUpdatedAt,
    drThresholds: entrant.drThresholds,
    cohorts: entrant.cohorts,
  });
  const artifacts = [
    'representative-queries.json',
    'entrant-cohort.json',
    'manifest.json',
    'status.json',
  ];
  await writeFile(join(enrichmentDirectory, 'representative-queries.json'), '{}\n');
  await writeFile(join(enrichmentDirectory, 'manifest.json'), JSON.stringify({
    enrichmentId,
    sourceRunId,
    modules: ['clusters', 'domain_age'],
    artifacts,
    state: 'completed',
    representativeQueries: { revision: 1 },
    entrantCohort: { representativeRevision: 1 },
  }, null, 2) + '\n');
  await writeFile(join(enrichmentDirectory, 'status.json'), JSON.stringify({
    enrichmentId,
    sourceRunId,
    status: 'completed',
    modules: ['clusters', 'domain_age'],
    artifacts,
    representativeQueries: { revision: 1 },
    entrantCohort: { representativeRevision: 1 },
  }, null, 2) + '\n');

  return { researchDirectory, discoveryDirectory, enrichmentDirectory, enrichmentId, sourceRunId };
}

const POLICY_ARGS = [
  '--young-domain-max-age-days', '365',
  '--recent-web-presence-max-age-days', '180',
  '--repurpose-gap-min-days', '1000',
];

test('cohort-history CLI persists, publishes and reuses explicit policy idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cohort-history-cli-'));
  try {
    const fixture = await prepareFixture(root);
    const first = await runCli([
      '--enrichment', fixture.enrichmentId,
      '--output-root', root,
      ...POLICY_ARGS,
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /1\/1 cohort domain\(s\) checked/);
    assert.match(first.stdout, /young: 1/);
    assert.match(first.stdout, /recent: 1/);
    assert.match(first.stdout, /\(changed\)/);

    let store = RunStore.open(join(fixture.enrichmentDirectory, 'enrichment.sqlite'));
    let state = loadCohortHistoryState(store, fixture.enrichmentId);
    assert.equal(state?.projections[0]?.summary.checkedDomainCount, 1);
    assert.equal(state?.projections[0]?.summary.youngDomainCount, 1);
    assert.equal(state?.projections[0]?.summary.recentWebPresenceCount, 1);
    store.close();

    const second = await runCli([
      '--enrichment', fixture.enrichmentId,
      '--output-root', root,
    ]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /\(unchanged\)/);

    store = RunStore.open(join(fixture.enrichmentDirectory, 'enrichment.sqlite'));
    state = loadCohortHistoryState(store, fixture.enrichmentId);
    assert.equal(state?.policy.youngDomainMaxAgeDays, 365);
    assert.equal(state?.policy.recentWebPresenceMaxAgeDays, 180);
    assert.equal(state?.policy.repurposeGapMinDays, 1000);
    store.close();

    const summaryCsv = await readFile(join(fixture.enrichmentDirectory, 'cohort-history-summary.csv'), 'utf8');
    assert.match(summaryCsv, /checked_coverage_numerator,checked_coverage_denominator/);
    const json = JSON.parse(await readFile(join(fixture.enrichmentDirectory, 'cohort-history.json'), 'utf8')) as {
      entrantFingerprint: string;
      projections: Array<{ summary: { checkedCoverage: { denominator: number } } }>;
    };
    assert.match(json.entrantFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(json.projections[0]?.summary.checkedCoverage.denominator, 1);

    const manifest = JSON.parse(await readFile(join(fixture.enrichmentDirectory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      cohortHistory: { changed: boolean; checkedDomainCount: number; policy: { youngDomainMaxAgeDays: number } };
    };
    assert.equal(manifest.cohortHistory.changed, false);
    assert.equal(manifest.cohortHistory.checkedDomainCount, 1);
    assert.equal(manifest.cohortHistory.policy.youngDomainMaxAgeDays, 365);
    assert.equal(manifest.artifacts.includes('cohort-history.csv'), true);
    assert.equal(manifest.artifacts.includes('cohort-history-summary.csv'), true);
    assert.equal(manifest.artifacts.includes('cohort-history.json'), true);

    await readFile(join(fixture.researchDirectory, 'results.zip'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('first cohort-history run refuses missing policy instead of inventing thresholds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cohort-history-policy-'));
  try {
    const fixture = await prepareFixture(root);
    const result = await runCli([
      '--enrichment', fixture.enrichmentId,
      '--output-root', root,
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /First cohort-history run requires explicit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cohort-history CLI rejects source generation drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cohort-history-stale-'));
  try {
    const fixture = await prepareFixture(root);
    const sourceStore = RunStore.open(join(fixture.discoveryDirectory, 'run.sqlite'));
    sourceStore.setRunState(fixture.sourceRunId, 'completed', { updatedAt: '2026-08-29T11:00:00.000Z' });
    sourceStore.close();

    const result = await runCli([
      '--enrichment', fixture.enrichmentId,
      '--output-root', root,
      ...POLICY_ARGS,
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /changed after the persisted entrant-cohort snapshot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
