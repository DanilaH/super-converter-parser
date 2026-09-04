import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { saveRepresentativeQuerySnapshot } from '../db/representativeSets.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import {
  writeEnrichmentIndex,
  writeRunIndex,
} from '../outputs/researchLayout.js';

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/entrantCohort.ts', ...args],
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

function rows(keywordIdx: number, keyword: string) {
  return [
    {
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
    },
    {
      keyword,
      position: 2,
      title: 'unique',
      url: `https://unique-${keywordIdx}.test/tool`,
      hostname: `unique-${keywordIdx}.test`,
      registrableDomain: `unique-${keywordIdx}.test`,
      dr: keywordIdx === 0 ? 70 : null,
      drStatus: keywordIdx === 0 ? 'ok' as const : null,
      drError: null,
      resultType: 'organic' as const,
    },
  ];
}

async function prepareFixture(root: string): Promise<{
  researchDirectory: string;
  discoveryDirectory: string;
  enrichmentDirectory: string;
  enrichmentId: string;
  sourceRunId: string;
}> {
  const researchDirectory = join(root, '2026-08-29-entrant-test');
  const discoveryDirectory = join(researchDirectory, 'discovery');
  const enrichmentDirectory = join(researchDirectory, 'enrichment');
  await mkdir(discoveryDirectory, { recursive: true });
  await mkdir(enrichmentDirectory, { recursive: true });

  const sourceRunId = 'source-run';
  const enrichmentId = 'enr-entrant';
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
  sourceStore.replaceSerpRows(sourceRunId, 0, rows(0, 'speaker test'));
  sourceStore.replaceSerpRows(sourceRunId, 1, rows(1, 'audio test'));
  sourceStore.setRunState(sourceRunId, 'completed', { updatedAt: '2026-08-29T10:00:00.000Z' });
  sourceStore.close();

  const enrichmentStore = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['clusters'],
    config: JSON.stringify({
      clusters: {
        topN: 10,
        edgeRule: { minSharedDomains: 3, minJaccard: 0.3, minSharedUrls: 2, minUrlJaccard: 0.1 },
        algorithmVersion: '2.0.0',
        urlIdentityVersion: '1.0.0',
        groupingRule: 'complete_link',
      },
    }),
    sourceRunDirectory: discoveryDirectory,
    enrichmentDirectory,
    shortlistKeywords: [],
  });
  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'clusters',
    module: 'clusters',
    status: 'completed',
    source: 'serp_overlap',
    cacheStatus: 'none',
    fetchedAt: '2026-08-29T10:05:00.000Z',
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
          coverageGain: 2,
        },
        {
          keywordIdx: 1,
          keyword: 'audio test',
          normalizedKeyword: 'audio test',
          volume: 200,
          selectionReason: 'high_demand',
          coverageGain: 1,
        },
      ],
      targetCount: 2,
      clusterUrlCount: 3,
      coveredUrlCount: 3,
      manualOverride: false,
      manualOverrideReason: null,
    }],
  );
  enrichmentStore.close();

  await writeRunIndex(root, { version: 1, runId: sourceRunId, researchDirectory, discoveryDirectory });
  await writeEnrichmentIndex(root, { version: 1,
    enrichmentId,
    runId: sourceRunId,
    researchDirectory,
    enrichmentDirectory,
  });

  const artifacts = [
    'keyword-clusters.csv',
    'representative-queries.csv',
    'representative-queries.json',
    'manifest.json',
    'status.json',
  ];
  await writeFile(join(enrichmentDirectory, 'keyword-clusters.csv'), 'cluster_id\ncluster-1\n');
  await writeFile(join(enrichmentDirectory, 'representative-queries.csv'), 'cluster_id\ncluster-1\n');
  await writeFile(join(enrichmentDirectory, 'representative-queries.json'), '{}\n');
  await writeFile(join(enrichmentDirectory, 'manifest.json'), JSON.stringify({
    enrichmentId,
    sourceRunId,
    modules: ['clusters'],
    config: {},
    artifacts,
    state: 'completed',
    representativeQueries: { revision: 1 },
  }, null, 2) + '\n');
  await writeFile(join(enrichmentDirectory, 'status.json'), JSON.stringify({
    enrichmentId,
    sourceRunId,
    status: 'completed',
    modules: ['clusters'],
    artifacts,
    representativeQueries: { revision: 1 },
  }, null, 2) + '\n');

  return {
    researchDirectory,
    discoveryDirectory,
    enrichmentDirectory,
    enrichmentId,
    sourceRunId,
  };
}

test('entrant-cohort CLI persists, publishes and reruns idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'entrant-cli-'));
  try {
    const fixture = await prepareFixture(root);
    const args = ['--enrichment', fixture.enrichmentId, '--output-root', root];

    const first = await runCli(args);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /representative revision 1 \(changed\)/);
    assert.match(first.stdout, /Weak domain memberships: 1\/2 with known DR/);
    assert.match(first.stdout, /3 cluster-domain membership\(s\), 3 globally unique domain\(s\), 4 ranking occurrence\(s\)/);
    assert.match(first.stdout, /cross-cluster domains: 0/);

    let enrichmentStore = RunStore.open(join(fixture.enrichmentDirectory, 'enrichment.sqlite'));
    let state = loadEntrantCohortState(enrichmentStore, fixture.enrichmentId);
    assert.equal(state?.representativeRevision, 1);
    assert.equal(state?.cohorts.length, 1);
    assert.equal(state?.cohorts[0]?.summary.uniqueDomainCount, 3);
    assert.equal(state?.cohorts[0]?.summary.repeatedDomainCount, 1);
    assert.deepEqual(state?.cohorts[0]?.summary.pageIdentityCoverage, {
      numerator: 4,
      denominator: 4,
      ratio: 1,
    });
    assert.deepEqual(state?.cohorts[0]?.summary.weakDomainCoverage, {
      numerator: 1,
      denominator: 2,
      ratio: 0.5,
    });
    enrichmentStore.close();

    const second = await runCli(args);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /representative revision 1 \(unchanged\)/);

    enrichmentStore = RunStore.open(join(fixture.enrichmentDirectory, 'enrichment.sqlite'));
    state = loadEntrantCohortState(enrichmentStore, fixture.enrichmentId);
    assert.equal(state?.representativeRevision, 1);
    enrichmentStore.close();

    const json = JSON.parse(
      await readFile(join(fixture.enrichmentDirectory, 'entrant-cohort.json'), 'utf8'),
    ) as {
      representativeRevision: number;
      sourceRunUpdatedAt: string;
      cohorts: Array<{ warnings: string[] }>;
    };
    assert.equal(json.representativeRevision, 1);
    assert.equal(json.sourceRunUpdatedAt, '2026-08-29T10:00:00.000Z');
    assert.equal(json.cohorts[0]?.warnings.length, 1);

    const occurrences = await readFile(
      join(fixture.enrichmentDirectory, 'entrant-cohort-occurrences.csv'),
      'utf8',
    );
    assert.match(occurrences, /repeat\.test/);
    assert.match(occurrences, /unique-0\.test/);
    assert.match(occurrences, /unique-1\.test/);

    const manifest = JSON.parse(
      await readFile(join(fixture.enrichmentDirectory, 'manifest.json'), 'utf8'),
    ) as {
      artifacts: string[];
      entrantCohort: {
        changed: boolean;
        representativeRevision: number;
        rankingOccurrenceCount: number;
        clusterDomainMembershipCount: number;
        globalUniqueDomainCount: number;
        crossClusterDomainCount: number;
        knownDrDomainMembershipCount: number;
        weakDomainMembershipCount: number;
        withinClusterRepeatedDomainMembershipCount: number;
      };
      representativeQueries: { revision: number };
    };
    assert.equal(manifest.representativeQueries.revision, 1);
    assert.equal(manifest.entrantCohort.changed, false);
    assert.equal(manifest.entrantCohort.representativeRevision, 1);
    assert.equal(manifest.entrantCohort.rankingOccurrenceCount, 4);
    assert.equal(manifest.entrantCohort.clusterDomainMembershipCount, 3);
    assert.equal(manifest.entrantCohort.globalUniqueDomainCount, 3);
    assert.equal(manifest.entrantCohort.crossClusterDomainCount, 0);
    assert.equal(manifest.entrantCohort.knownDrDomainMembershipCount, 2);
    assert.equal(manifest.entrantCohort.weakDomainMembershipCount, 1);
    assert.equal(manifest.entrantCohort.withinClusterRepeatedDomainMembershipCount, 1);
    assert.equal(manifest.artifacts.includes('entrant-cohort.csv'), true);
    assert.equal(manifest.artifacts.includes('entrant-cohort-occurrences.csv'), true);
    assert.equal(manifest.artifacts.includes('entrant-cohort.json'), true);

    await readFile(join(fixture.researchDirectory, 'results.zip'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('entrant-cohort CLI rejects source mutation after clustering instead of mixing evidence generations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'entrant-cli-stale-'));
  try {
    const fixture = await prepareFixture(root);
    const sourceStore = RunStore.open(join(fixture.discoveryDirectory, 'run.sqlite'));
    sourceStore.setRunState(fixture.sourceRunId, 'completed', { updatedAt: '2099-01-01T00:00:00.000Z' });
    sourceStore.close();

    const result = await runCli([
      '--enrichment', fixture.enrichmentId,
      '--output-root', root,
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /modified after the persisted clustering snapshot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
