import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import {
  loadRepresentativeQueryHistory,
  loadRepresentativeQueryState,
} from '../db/representativeSets.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import {
  writeEnrichmentIndex,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import {
  CLUSTERING_ALGORITHM_VERSION,
  DEFAULT_CLUSTER_MIN_SHARED_URLS,
  DEFAULT_CLUSTER_MIN_URL_JACCARD,
  type ClusteringConfig,
} from '../enrichment/clustering.js';
import { CLUSTER_URL_IDENTITY_VERSION } from '../enrichment/urlIdentity.js';

const V2_CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: {
    minSharedDomains: 3,
    minJaccard: 0.3,
    minSharedUrls: DEFAULT_CLUSTER_MIN_SHARED_URLS,
    minUrlJaccard: DEFAULT_CLUSTER_MIN_URL_JACCARD,
  },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
  urlIdentityVersion: CLUSTER_URL_IDENTITY_VERSION,
  groupingRule: 'complete_link',
};

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/representatives.ts', ...args],
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

function serpRows(keywordIdx: number, keyword: string, uniqueDomain: string) {
  const specs = [
    ['a.test', 'https://a.test/tool'],
    ['b.test', 'https://b.test/tool'],
    ['c.test', `https://c.test/${keywordIdx}`],
    [uniqueDomain, `https://${uniqueDomain}/tool`],
  ] as const;
  return specs.map(([domain, url], index) => ({
    keyword,
    position: index + 1,
    title: `${keyword} result ${index + 1}`,
    url,
    hostname: domain,
    registrableDomain: domain,
    dr: null,
    drStatus: null,
    resultType: 'organic' as const,
  }));
}

function strongPair(a: number, b: number) {
  return {
    keywordAIdx: a,
    keywordBIdx: b,
    keywordA: `q${a}`,
    keywordB: `q${b}`,
    intersectionCount: 3,
    unionCount: 5,
    jaccard: 0.6,
    sharedDomains: ['a.test', 'b.test', 'c.test'],
    sharedUrls: ['a.test/tool', 'b.test/tool'],
    urlIntersectionCount: 2,
    urlUnionCount: 6,
    urlJaccard: 1 / 3,
    domainIntersectionCount: 3,
    domainUnionCount: 5,
    domainJaccard: 0.6,
    classification: 'strong' as const,
    isEdge: true,
  };
}

async function prepareFixture(root: string): Promise<{
  researchDirectory: string;
  enrichmentDirectory: string;
  enrichmentId: string;
}> {
  const researchDirectory = join(root, '2026-08-29-representatives-test');
  const discoveryDirectory = join(researchDirectory, 'discovery');
  const enrichmentDirectory = join(researchDirectory, 'enrichment');
  await mkdir(discoveryDirectory, { recursive: true });
  await mkdir(enrichmentDirectory, { recursive: true });

  const sourceRunId = 'source-run';
  const enrichmentId = 'enr-representatives';
  const sourceStore = RunStore.open(join(discoveryDirectory, 'run.sqlite'));
  const config = loadConfig({});
  const keywords = buildSeedKeywords([
    { keyword: 'q0', rowNumber: 1 },
    { keyword: 'q1', rowNumber: 2 },
    { keyword: 'q2', rowNumber: 3 },
  ]);
  sourceStore.createRun({
    runId: sourceRunId,
    configSnapshot: config,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/test.csv' },
    keywords,
  });
  sourceStore.replaceSerpRows(sourceRunId, 0, serpRows(0, 'q0', 'd.test'));
  sourceStore.replaceSerpRows(sourceRunId, 1, serpRows(1, 'q1', 'e.test'));
  sourceStore.replaceSerpRows(sourceRunId, 2, serpRows(2, 'q2', 'f.test'));
  sourceStore.setRunState(sourceRunId, 'completed', { updatedAt: '2026-08-29T10:00:00.000Z' });
  sourceStore.close();

  const enrichmentStore = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['clusters'],
    config: JSON.stringify({ clusters: V2_CONFIG }),
    sourceRunDirectory: discoveryDirectory,
    enrichmentDirectory,
    shortlistKeywords: [],
  });
  enrichmentStore.saveKeywordClusters(enrichmentId, [{
    clusterId: 'cluster-1',
    canonicalKeywordIdx: 0,
    canonicalKeyword: 'q0',
    members: [
      { keywordIdx: 0, keyword: 'q0', normalizedKeyword: 'q0', volume: 100, serpSize: 4 },
      { keywordIdx: 1, keyword: 'q1', normalizedKeyword: 'q1', volume: 900, serpSize: 4 },
      { keywordIdx: 2, keyword: 'q2', normalizedKeyword: 'q2', volume: 500, serpSize: 4 },
    ],
    representativeDomains: ['a.test', 'b.test', 'c.test'],
    medianVolume: 500,
    averageVolume: 500,
    cohesion: {
      pairCount: 3,
      urlJaccard: { min: 1 / 3, median: 1 / 3, mean: 1 / 3 },
      domainJaccard: { min: 0.6, median: 0.6, mean: 0.6 },
    },
    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
    config: V2_CONFIG,
  }]);
  enrichmentStore.saveEnrichmentPairs(enrichmentId, [
    strongPair(0, 1),
    strongPair(0, 2),
    strongPair(1, 2),
  ]);
  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'clusters',
    module: 'clusters',
    status: 'completed',
    source: 'serp_overlap',
    cacheStatus: 'none',
  });
  enrichmentStore.setEnrichmentState(enrichmentId, 'completed');
  enrichmentStore.close();

  await writeRunIndex(root, {
    runId: sourceRunId,
    researchDirectory,
    discoveryDirectory,
  });
  await writeEnrichmentIndex(root, {
    enrichmentId,
    runId: sourceRunId,
    researchDirectory,
    enrichmentDirectory,
  });

  const artifacts = ['keyword-clusters.csv', 'keyword-clusters.json', 'manifest.json', 'status.json'];
  await writeFile(join(enrichmentDirectory, 'keyword-clusters.csv'), 'cluster_id\ncluster-1\n');
  await writeFile(join(enrichmentDirectory, 'keyword-clusters.json'), '{}\n');
  await writeFile(join(enrichmentDirectory, 'manifest.json'), JSON.stringify({
    enrichmentId,
    sourceRunId,
    modules: ['clusters'],
    config: { clusters: V2_CONFIG },
    artifacts,
    summary: { clusterCount: 1 },
    state: 'completed',
  }, null, 2) + '\n');
  await writeFile(join(enrichmentDirectory, 'status.json'), JSON.stringify({
    enrichmentId,
    sourceRunId,
    status: 'completed',
    modules: ['clusters'],
    artifacts,
    summary: { clusterCount: 1 },
  }, null, 2) + '\n');

  return { researchDirectory, enrichmentDirectory, enrichmentId };
}

test('representatives CLI requires explicit first-run finalist scope, persists it, reruns idempotently, then revisions an override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'representatives-cli-'));
  try {
    const fixture = await prepareFixture(root);
    const common = ['--enrichment', fixture.enrichmentId, '--output-root', root];

    const unscoped = await runCli(common);
    assert.equal(unscoped.code, 2);
    assert.match(unscoped.stderr, /requires explicit finalist scope/);

    const first = await runCli([...common, '--all-clusters']);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /revision 1 \(new\)/);
    assert.match(first.stdout, /Finalist clusters: cluster-1/);

    let store = RunStore.open(join(fixture.enrichmentDirectory, 'enrichment.sqlite'));
    let state = loadRepresentativeQueryState(store, fixture.enrichmentId);
    assert.equal(state?.revision, 1);
    assert.deepEqual(state?.config.selectedClusterIds, ['cluster-1']);
    assert.deepEqual(state?.sets[0]?.representativeKeywordIds, [0, 1, 2]);
    assert.equal(loadRepresentativeQueryHistory(store, fixture.enrichmentId).length, 1);
    store.close();

    // Scope is durable; no scope flag is needed after the first successful run.
    const second = await runCli(common);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /revision 1 \(unchanged\)/);

    const overridePath = join(root, 'overrides.json');
    await writeFile(overridePath, JSON.stringify([
      { clusterId: 'cluster-1', keywordIds: [2, 0], reason: 'manual intent review' },
    ]));
    const third = await runCli([...common, '--representative-overrides', overridePath]);
    assert.equal(third.code, 0, third.stderr);
    assert.match(third.stdout, /revision 2 \(new\)/);

    store = RunStore.open(join(fixture.enrichmentDirectory, 'enrichment.sqlite'));
    state = loadRepresentativeQueryState(store, fixture.enrichmentId);
    assert.equal(state?.revision, 2);
    assert.deepEqual(state?.config.selectedClusterIds, ['cluster-1']);
    assert.deepEqual(state?.sets[0]?.representativeKeywordIds, [2, 0]);
    assert.equal(state?.sets[0]?.manualOverrideReason, 'manual intent review');
    assert.equal(loadRepresentativeQueryHistory(store, fixture.enrichmentId).length, 2);
    store.close();

    const artifact = JSON.parse(
      await readFile(join(fixture.enrichmentDirectory, 'representative-queries.json'), 'utf8'),
    ) as {
      revision: number;
      config: { selectedClusterIds: string[] };
      sets: Array<{
        representativeKeywordIds: number[];
        previousRepresentativeKeywordIds: number[] | null;
        changedFromPrevious: boolean | null;
      }>;
    };
    assert.equal(artifact.revision, 2);
    assert.deepEqual(artifact.config.selectedClusterIds, ['cluster-1']);
    assert.deepEqual(artifact.sets[0]?.representativeKeywordIds, [2, 0]);
    assert.deepEqual(artifact.sets[0]?.previousRepresentativeKeywordIds, [0, 1, 2]);
    assert.equal(artifact.sets[0]?.changedFromPrevious, true);

    const manifest = JSON.parse(
      await readFile(join(fixture.enrichmentDirectory, 'manifest.json'), 'utf8'),
    ) as {
      artifacts: string[];
      config: { representative_queries: { selectedClusterIds: string[] } };
      representativeQueries: { revision: number };
    };
    assert.equal(manifest.representativeQueries.revision, 2);
    assert.deepEqual(manifest.config.representative_queries.selectedClusterIds, ['cluster-1']);
    assert.equal(manifest.artifacts.includes('representative-queries.csv'), true);
    assert.equal(manifest.artifacts.includes('representative-queries.json'), true);

    await readFile(join(fixture.researchDirectory, 'results.zip'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
