import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { saveRepresentativeQuerySnapshot } from '../db/representativeSets.js';
import { RunStore } from '../db/store.js';
import type { SerpResult } from '../google/serp.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import {
  allocateEnrichmentDirectory,
  allocateResearchLocation,
  resolveRunLocation,
  writeEnrichmentIndex,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { prepareResearchAppend } from './batches.js';
import { buildResearchGenerationDiff, parseResearchGenerationRef } from './diff.js';

const CONFIG = loadConfig({});
const CLUSTER_CONFIG = {
  topN: 10,
  edgeRule: {
    minSharedDomains: 3,
    minJaccard: 0.3,
    minSharedUrls: 2,
    minUrlJaccard: 0.1,
  },
  algorithmVersion: '2.0.0',
  urlIdentityVersion: '1.0.0',
  groupingRule: 'complete_link' as const,
};
const COHESION = {
  pairCount: 0,
  urlJaccard: null,
  domainJaccard: null,
};

function completeDiscoveryKeyword(
  store: RunStore,
  runId: string,
  idx: number,
  googleStatus: 'empty' | 'fetch_error' = 'empty',
): void {
  const keyword = store.loadKeyword(runId, idx);
  assert.ok(keyword);
  const successful = googleStatus === 'empty';
  store.commitKeyword(
    runId,
    {
      ...keyword,
      status: successful ? 'completed' : 'partial',
      surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-08-31T00:00:00.000Z' },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: `https://google.com/search?q=${idx}`,
        detectedLocation: null,
        geoWarning: false,
        serpStatus: googleStatus,
        serpError: successful ? null : { code: 'GOOGLE_UNAVAILABLE', message: 'fixture unavailable' },
      },
      error: successful ? null : { code: 'GOOGLE_UNAVAILABLE', message: 'fixture unavailable' },
      collectedAt: '2026-08-31T00:00:00.000Z',
    },
    [] as SerpResult[],
    'miss',
  );
}

async function createCompletedResearch(outputRoot: string): Promise<{
  runId: string;
  researchDirectory: string;
  discoveryDirectory: string;
}> {
  const runId = 'run_diff_initial';
  const inputPath = join(outputRoot, 'initial.csv');
  await writeFile(inputPath, 'keyword\nalpha tool\nbeta tool\n', 'utf8');
  const location = await allocateResearchLocation(outputRoot, 'Diff Fixture', new Date('2026-08-31T00:00:00.000Z'));
  const store = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
  store.createRun({
    runId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
    input: { kind: 'seeds', path: inputPath },
    keywords: [
      { keyword: 'alpha tool', normalizedKeyword: 'alpha tool', sourceRows: [2] },
      { keyword: 'beta tool', normalizedKeyword: 'beta tool', sourceRows: [3] },
    ],
  });
  completeDiscoveryKeyword(store, runId, 0);
  completeDiscoveryKeyword(store, runId, 1);
  store.setRunState(runId, 'completed', { updatedAt: '2026-08-31T00:01:00.000Z' });
  store.close();
  await writeRunIndex(outputRoot, {
    version: 1,
    runId,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });
  return {
    runId,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  };
}

function representativeSet(clusterId: string, keywordIdx: number, keyword: string) {
  return {
    clusterId,
    setVersion: '1.0.0',
    representativeKeywordIds: [keywordIdx],
    representatives: [{
      keywordIdx,
      keyword,
      normalizedKeyword: keyword,
      volume: 100,
      selectionReason: 'medoid' as const,
      coverageGain: 1,
    }],
    targetCount: 1,
    clusterUrlCount: 1,
    coveredUrlCount: 1,
    manualOverride: false,
    manualOverrideReason: null,
  };
}

function cluster(clusterId: string, canonicalIdx: number, canonical: string, members: Array<[number, string]>) {
  return {
    clusterId,
    canonicalKeywordIdx: canonicalIdx,
    canonicalKeyword: canonical,
    members: members.map(([keywordIdx, keyword]) => ({
      keywordIdx,
      keyword,
      normalizedKeyword: keyword,
      volume: 100,
      serpSize: 10,
    })),
    representativeDomains: ['example.com'],
    medianVolume: 100,
    averageVolume: 100,
    cohesion: COHESION,
    algorithmVersion: '2.0.0',
    config: CLUSTER_CONFIG,
  };
}

test('generation refs are explicit and reject ambiguous/bad values', () => {
  assert.deepEqual(parseResearchGenerationRef('discovery:2'), { kind: 'discovery', generation: 2 });
  assert.deepEqual(parseResearchGenerationRef('enrichment:17'), { kind: 'enrichment', generation: 17 });
  assert.throws(() => parseResearchGenerationRef('2'), /Use discovery:<n> or enrichment:<n>/);
  assert.throws(() => parseResearchGenerationRef('discovery:0'), /positive integer/);
});

test('discovery diff compares a real append-generated immutable generation factually', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-diff-discovery-'));
  const initial = await createCompletedResearch(outputRoot);
  const appendPath = join(outputRoot, 'append.csv');
  await writeFile(appendPath, 'keyword\nbeta tool\ngamma tool\n', 'utf8');
  const append = await prepareResearchAppend({
    outputRoot,
    targetRunId: initial.runId,
    seedsPath: appendPath,
    seeds: [
      { keyword: 'beta tool', normalizedKeyword: 'beta tool', sourceRows: [2] },
      { keyword: 'gamma tool', normalizedKeyword: 'gamma tool', sourceRows: [3] },
    ],
    now: () => new Date('2026-08-31T01:00:00.000Z'),
  });
  assert.equal(append.changed, true);

  const current = await resolveRunLocation(outputRoot, append.currentRunId);
  const store = RunStore.open(join(current.discoveryDirectory, 'run.sqlite'));
  try {
    completeDiscoveryKeyword(store, append.currentRunId, 2, 'fetch_error');
    store.setRunState(append.currentRunId, 'completed_with_errors', {
      updatedAt: '2026-08-31T01:01:00.000Z',
    });
  } finally {
    store.close();
  }

  const diff = await buildResearchGenerationDiff({
    outputRoot,
    targetRunId: initial.runId,
    from: 'discovery:1',
    to: 'discovery:2',
  });
  assert.equal(diff.kind, 'discovery');
  assert.equal(diff.discovery?.from.runId, initial.runId);
  assert.equal(diff.discovery?.to.runId, append.currentRunId);
  assert.deepEqual(diff.discovery?.keywords.added, [{
    normalizedKeyword: 'gamma tool',
    keyword: 'gamma tool',
    status: 'partial',
  }]);
  assert.deepEqual(diff.discovery?.keywords.removed, []);
  assert.deepEqual(diff.discovery?.keywords.statusChanges, []);
  assert.deepEqual(diff.discovery?.googleSerpCoverage.from, { numerator: 2, denominator: 2, ratio: 1 });
  assert.deepEqual(diff.discovery?.googleSerpCoverage.to, { numerator: 2, denominator: 3, ratio: 2 / 3 });
});

test('enrichment diff compares separate immutable re-enrichment generations with stable ordering', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-diff-enrichment-'));
  const initial = await createCompletedResearch(outputRoot);
  await writeFile(join(initial.researchDirectory, 'research.json'), `${JSON.stringify({
    version: 1,
    researchId: initial.runId,
    label: 'diff-enrichment-fixture',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    currentRunId: initial.runId,
    batches: [{
      batchId: 'batch-0001',
      createdAt: '2026-08-31T00:00:00.000Z',
      input: { kind: 'seeds', originalPath: 'initial.csv', storedPath: null },
      sourceRowCount: 2,
      inputUniqueKeywordCount: 2,
      addedKeywordCount: 2,
      duplicateKeywordCount: 0,
      normalizedKeywords: ['alpha tool', 'beta tool'],
      newNormalizedKeywords: ['alpha tool', 'beta tool'],
      resultRunId: initial.runId,
    }],
  }, null, 2)}\n`, 'utf8');

  const firstDirectory = await allocateEnrichmentDirectory(initial.researchDirectory);
  const firstId = 'enrichment_diff_1';
  const first = RunStore.open(join(firstDirectory, 'enrichment.sqlite'));
  first.createEnrichmentRun({
    enrichmentId: firstId,
    sourceRunId: initial.runId,
    modules: ['clusters'],
    config: '{}',
    sourceRunDirectory: initial.discoveryDirectory,
    enrichmentDirectory: firstDirectory,
  });
  first.saveKeywordClusters(firstId, [
    cluster('cluster-1', 0, 'alpha tool', [[0, 'alpha tool'], [1, 'beta tool']]),
  ]);
  saveRepresentativeQuerySnapshot(first, firstId, {
    targetCount: 5,
    overrides: [],
    setVersion: '1.0.0',
    selectedClusterIds: ['cluster-1'],
  }, [representativeSet('cluster-1', 0, 'alpha tool')]);
  first.setEnrichmentState(firstId, 'completed');
  first.close();
  await writeEnrichmentIndex(outputRoot, {
    version: 1,
    enrichmentId: firstId,
    runId: initial.runId,
    researchDirectory: initial.researchDirectory,
    enrichmentDirectory: firstDirectory,
  });

  const secondDirectory = await allocateEnrichmentDirectory(initial.researchDirectory);
  const secondId = 'enrichment_diff_2';
  const second = RunStore.open(join(secondDirectory, 'enrichment.sqlite'));
  second.createEnrichmentRun({
    enrichmentId: secondId,
    sourceRunId: initial.runId,
    modules: ['pages', 'clusters'],
    config: '{}',
    sourceRunDirectory: initial.discoveryDirectory,
    enrichmentDirectory: secondDirectory,
  });
  second.saveKeywordClusters(secondId, [
    cluster('cluster-1', 0, 'alpha tool', [[0, 'alpha tool'], [2, 'gamma tool']]),
    cluster('cluster-2', 1, 'beta tool', [[1, 'beta tool']]),
  ]);
  saveRepresentativeQuerySnapshot(second, secondId, {
    targetCount: 5,
    overrides: [],
    setVersion: '1.0.0',
    selectedClusterIds: ['cluster-1', 'cluster-2'],
  }, [
    representativeSet('cluster-1', 2, 'gamma tool'),
    representativeSet('cluster-2', 1, 'beta tool'),
  ]);
  second.setEnrichmentState(secondId, 'completed');
  second.close();
  await writeEnrichmentIndex(outputRoot, {
    version: 1,
    enrichmentId: secondId,
    runId: initial.runId,
    researchDirectory: initial.researchDirectory,
    enrichmentDirectory: secondDirectory,
  });

  const diff = await buildResearchGenerationDiff({
    outputRoot,
    targetRunId: initial.runId,
    from: 'enrichment:1',
    to: 'enrichment:2',
  });
  assert.equal(diff.kind, 'enrichment');
  assert.deepEqual(diff.enrichment?.modules, { added: ['pages'], removed: [] });
  assert.deepEqual(diff.enrichment?.clusters.added.map((row) => row.clusterId), ['cluster-2']);
  assert.deepEqual(diff.enrichment?.clusters.removed, []);
  assert.deepEqual(diff.enrichment?.clusters.changed, [{
    clusterId: 'cluster-1',
    canonicalKeywordFrom: 'alpha tool',
    canonicalKeywordTo: 'alpha tool',
    addedMembers: ['gamma tool'],
    removedMembers: ['beta tool'],
  }]);
  assert.equal(diff.enrichment?.clusters.matchingBasis, 'persisted_cluster_id');
  assert.deepEqual(diff.enrichment?.representatives, [
    { clusterId: 'cluster-1', from: ['alpha tool'], to: ['gamma tool'] },
    { clusterId: 'cluster-2', from: null, to: ['beta tool'] },
  ]);
  assert.deepEqual(diff.enrichment?.entrantDomains, []);
  assert.deepEqual(diff.enrichment?.historyCoverage, { from: null, to: null });
  assert.deepEqual(diff.enrichment?.trafficEvidence.from, {
    importedSnapshotCount: 0,
    policyAvailable: false,
    currentTargetSnapshotCount: null,
    staleTargetSnapshotCount: null,
    matchedSnapshotCount: null,
    mismatchedSnapshotCount: null,
  });
});

test('cross-kind generation refs fail instead of guessing a comparison model', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-diff-cross-kind-'));
  const initial = await createCompletedResearch(outputRoot);
  await assert.rejects(
    buildResearchGenerationDiff({
      outputRoot,
      targetRunId: initial.runId,
      from: 'discovery:1',
      to: 'enrichment:1',
    }),
    /Cannot compare discovery and enrichment generations/,
  );
});
