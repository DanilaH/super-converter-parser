import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import {
  loadTrafficEvidencePolicy,
  loadTrafficImportRecords,
} from '../db/trafficEvidence.js';
import { saveRepresentativeQuerySnapshot } from '../db/representativeSets.js';
import {
  saveEntrantCohortSnapshot,
  type EntrantCohortSnapshot,
} from '../db/entrantCohorts.js';
import { writeEntrantCohortJson } from '../enrichment/entrantCohortOutputs.js';
import { writeEnrichmentIndex } from '../outputs/researchLayout.js';

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/trafficEvidence.ts', ...args],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function prepareFixture(root: string) {
  const researchDirectory = join(root, '2026-08-29-traffic-test');
  const enrichmentDirectory = join(researchDirectory, 'enrichment');
  await mkdir(enrichmentDirectory, { recursive: true });

  const enrichmentId = 'enr-traffic-cli';
  const sourceRunId = 'source-traffic-cli';
  const store = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
  store.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['clusters'],
    config: JSON.stringify({ shortlist: ['tool test'] }),
    sourceRunDirectory: join(researchDirectory, 'discovery'),
    enrichmentDirectory,
    shortlistKeywords: ['tool test'],
  });
  store.setEnrichmentState(enrichmentId, 'completed');
  saveRepresentativeQuerySnapshot(
    store,
    enrichmentId,
    {
      targetCount: 3,
      overrides: [],
      setVersion: '1.0.0',
      selectedClusterIds: ['cluster-1'],
    },
    [{
      clusterId: 'cluster-1',
      setVersion: '1.0.0',
      representativeKeywordIds: [1],
      representatives: [{
        keywordIdx: 1,
        keyword: 'tool test',
        normalizedKeyword: 'tool test',
        volume: 100,
        selectionReason: 'medoid',
        coverageGain: 1,
      }],
      targetCount: 1,
      clusterUrlCount: 1,
      coveredUrlCount: 1,
      manualOverride: false,
      manualOverrideReason: null,
    }],
  );

  const occurrence = {
    keywordIdx: 1,
    position: 1,
    rankingUrl: 'https://example.test/tool?utm_source=serp',
    registrableDomain: 'example.test',
    normalizedPageIdentity: 'example.test/tool',
    dr: 20,
  };
  const entrant: EntrantCohortSnapshot = {
    enrichmentId,
    sourceRunId,
    representativeRevision: 1,
    cohortVersion: '1.0.0',
    serpTopN: 10,
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
    sourceRunUpdatedAt: '2026-08-29T10:00:00.000Z',
    clusteringUpdatedAt: '2026-08-29T10:05:00.000Z',
    cohorts: [{
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
    }],
  };
  saveEntrantCohortSnapshot(store, entrant);
  store.close();

  await writeEnrichmentIndex(root, {
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

  const artifacts = ['representative-queries.json', 'entrant-cohort.json', 'manifest.json', 'status.json'];
  const common = {
    enrichmentId,
    sourceRunId,
    modules: ['clusters'],
    artifacts,
    representativeQueries: { revision: 1 },
    entrantCohort: { representativeRevision: 1 },
  };
  await writeFile(join(enrichmentDirectory, 'representative-queries.json'), '{}\n');
  await writeFile(join(enrichmentDirectory, 'manifest.json'), JSON.stringify({
    ...common,
    state: 'completed',
  }, null, 2) + '\n');
  await writeFile(join(enrichmentDirectory, 'status.json'), JSON.stringify({
    ...common,
    status: 'completed',
  }, null, 2) + '\n');

  return { researchDirectory, enrichmentDirectory, enrichmentId };
}

const HEADER = [
  'target_cluster_id',
  'scope',
  'entity',
  'observed_at',
  'provider_data_date',
  'market',
  'source',
  'organic_traffic',
  'traffic_value',
  'traffic_value_currency',
  'provenance',
].join(',');

async function writeTrafficCsv(path: string): Promise<void> {
  await writeFile(path, [
    HEADER,
    'cluster-1,domain,example.test,2026-07-02T00:00:00Z,2026-07-01,US,manual-provider,50,100,USD,july export',
    'cluster-1,domain,example.test,2026-08-02T00:00:00Z,2026-08-01,US,manual-provider,100,150,USD,august export',
    'cluster-1,domain,other.test,2026-08-02T00:00:00Z,2026-08-01,US,manual-provider,70,,,wrong target audit',
    '',
  ].join('\n'));
}

test('traffic-evidence CLI imports, publishes and reprojects append-only snapshots idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'traffic-cli-'));
  try {
    const fixture = await prepareFixture(root);
    const inputPath = join(root, 'traffic.csv');
    await writeTrafficCsv(inputPath);

    const first = await runCli([
      '--enrichment', fixture.enrichmentId,
      '--output-root', root,
      '--input', inputPath,
      '--low-base-organic-traffic-threshold', '100',
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /3 imported snapshot\(s\)/);
    assert.match(first.stdout, /2 current target match\(es\), 1 mismatch\(es\)/);
    assert.match(first.stdout, /velocity intervals: 1/);
    assert.match(first.stdout, /3 inserted, 0 duplicate\(s\)/);

    let store = RunStore.open(join(fixture.enrichmentDirectory, 'enrichment.sqlite'));
    assert.equal(loadTrafficImportRecords(store, fixture.enrichmentId).length, 3);
    assert.equal(loadTrafficEvidencePolicy(store, fixture.enrichmentId)?.lowBaseOrganicTrafficThreshold, 100);
    store.close();

    const velocityCsv = await readFile(join(fixture.enrichmentDirectory, 'traffic-velocity.csv'), 'utf8');
    assert.match(velocityCsv, /organic_traffic_percent_delta/);
    assert.match(velocityCsv, /50,100,50,100,true/);
    const evidenceCsv = await readFile(join(fixture.enrichmentDirectory, 'traffic-evidence.csv'), 'utf8');
    assert.match(evidenceCsv, /other\.test/);
    assert.match(evidenceCsv, /mismatch,domain_not_in_target/);

    const manifest = JSON.parse(await readFile(join(fixture.enrichmentDirectory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
      trafficEvidence: { importedSnapshotCount: number; mismatchedSnapshotCount: number };
    };
    assert.equal(manifest.trafficEvidence.importedSnapshotCount, 3);
    assert.equal(manifest.trafficEvidence.mismatchedSnapshotCount, 1);
    assert.equal(manifest.artifacts.includes('traffic-evidence.json'), true);
    assert.equal(manifest.artifacts.includes('traffic-evidence.csv'), true);
    assert.equal(manifest.artifacts.includes('traffic-velocity.csv'), true);
    await readFile(join(fixture.researchDirectory, 'results.zip'));

    const second = await runCli([
      '--enrichment', fixture.enrichmentId,
      '--output-root', root,
    ]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /3 imported snapshot\(s\)/);
    assert.doesNotMatch(second.stdout, /Import:/);

    store = RunStore.open(join(fixture.enrichmentDirectory, 'enrichment.sqlite'));
    assert.equal(loadTrafficImportRecords(store, fixture.enrichmentId).length, 3);
    assert.equal(loadTrafficEvidencePolicy(store, fixture.enrichmentId)?.lowBaseOrganicTrafficThreshold, 100);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('first traffic-evidence run refuses hidden low-base threshold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'traffic-cli-policy-'));
  try {
    const fixture = await prepareFixture(root);
    const inputPath = join(root, 'traffic.csv');
    await writeTrafficCsv(inputPath);
    const result = await runCli([
      '--enrichment', fixture.enrichmentId,
      '--output-root', root,
      '--input', inputPath,
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /requires explicit --low-base-organic-traffic-threshold/);

    const store = RunStore.open(join(fixture.enrichmentDirectory, 'enrichment.sqlite'));
    assert.equal(loadTrafficImportRecords(store, fixture.enrichmentId).length, 0);
    assert.equal(loadTrafficEvidencePolicy(store, fixture.enrichmentId), null);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ambiguous incoming revision fails before append-only evidence is mutated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'traffic-cli-ambiguous-'));
  try {
    const fixture = await prepareFixture(root);
    const inputPath = join(root, 'ambiguous.csv');
    await writeFile(inputPath, [
      HEADER,
      'cluster-1,domain,example.test,2026-08-02T00:00:00Z,2026-08-01,US,manual-provider,100,,,import A',
      'cluster-1,domain,example.test,2026-08-02T00:00:00Z,2026-08-01,US,manual-provider,120,,,import B',
      '',
    ].join('\n'));

    const result = await runCli([
      '--enrichment', fixture.enrichmentId,
      '--output-root', root,
      '--input', inputPath,
      '--low-base-organic-traffic-threshold', '100',
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Ambiguous traffic revisions/);

    const store = RunStore.open(join(fixture.enrichmentDirectory, 'enrichment.sqlite'));
    assert.equal(loadTrafficImportRecords(store, fixture.enrichmentId).length, 0);
    assert.equal(loadTrafficEvidencePolicy(store, fixture.enrichmentId), null);
    store.close();
    await assert.rejects(readFile(join(fixture.enrichmentDirectory, 'traffic-evidence.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
