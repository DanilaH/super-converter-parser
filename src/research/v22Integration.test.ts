import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { loadRepresentativeQueryState, saveRepresentativeQuerySnapshot } from '../db/representativeSets.js';
import { RunStore } from '../db/store.js';
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
import { buildResearchGenerationDiff } from './diff.js';
import { buildResearchStatus } from './status.js';

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

function completeKeyword(store: RunStore, runId: string, idx: number): void {
  const keyword = store.loadKeyword(runId, idx);
  assert.ok(keyword);
  store.commitKeyword(runId, {
    ...keyword,
    status: 'completed',
    surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-08-31T00:00:00.000Z' },
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: `https://google.com/search?q=${idx}`,
      detectedLocation: null,
      geoWarning: false,
      serpStatus: 'empty',
      serpError: null,
    },
    error: null,
    collectedAt: '2026-08-31T00:00:00.000Z',
  }, [], 'miss');
}

function cluster(
  clusterId: string,
  canonicalKeywordIdx: number,
  canonicalKeyword: string,
  members: Array<[number, string]>,
) {
  return {
    clusterId,
    canonicalKeywordIdx,
    canonicalKeyword,
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

async function createEnrichment(input: {
  outputRoot: string;
  researchDirectory: string;
  discoveryDirectory: string;
  sourceRunId: string;
  enrichmentId: string;
  modules: string[];
  clusters: ReturnType<typeof cluster>[];
  representatives: ReturnType<typeof representativeSet>[];
}): Promise<string> {
  const directory = await allocateEnrichmentDirectory(input.researchDirectory);
  const store = RunStore.open(join(directory, 'enrichment.sqlite'));
  try {
    store.createEnrichmentRun({
      enrichmentId: input.enrichmentId,
      sourceRunId: input.sourceRunId,
      modules: input.modules,
      config: '{}',
      sourceRunDirectory: input.discoveryDirectory,
      enrichmentDirectory: directory,
    });
    store.saveKeywordClusters(input.enrichmentId, input.clusters);
    saveRepresentativeQuerySnapshot(store, input.enrichmentId, {
      targetCount: 5,
      overrides: [],
      setVersion: '1.0.0',
      selectedClusterIds: input.representatives.map((row) => row.clusterId),
    }, input.representatives);
    store.setEnrichmentState(input.enrichmentId, 'completed');
  } finally {
    store.close();
  }
  await writeEnrichmentIndex(input.outputRoot, {
    version: 1,
    enrichmentId: input.enrichmentId,
    runId: input.sourceRunId,
    researchDirectory: input.researchDirectory,
    enrichmentDirectory: directory,
  });
  return directory;
}

test('V2.2 operator surfaces stay coherent across append and re-enrichment without mutating old generations', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'v22-integration-'));
  const initialInput = join(outputRoot, 'initial.csv');
  await writeFile(initialInput, 'keyword\nalpha tool\nbeta tool\n', 'utf8');
  const location = await allocateResearchLocation(
    outputRoot,
    'V2.2 Integration',
    new Date('2026-08-31T00:00:00.000Z'),
  );
  const initialRunId = 'run_v22_integration_initial';
  const initialStore = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
  initialStore.createRun({
    runId: initialRunId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
    input: { kind: 'seeds', path: initialInput },
    keywords: [
      { keyword: 'alpha tool', normalizedKeyword: 'alpha tool', sourceRows: [2] },
      { keyword: 'beta tool', normalizedKeyword: 'beta tool', sourceRows: [3] },
    ],
  });
  completeKeyword(initialStore, initialRunId, 0);
  completeKeyword(initialStore, initialRunId, 1);
  initialStore.setRunState(initialRunId, 'completed', { updatedAt: '2026-08-31T00:01:00.000Z' });
  initialStore.close();
  await writeRunIndex(outputRoot, {
    version: 1,
    runId: initialRunId,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });

  const firstEnrichmentId = 'enrichment_v22_integration_1';
  const firstEnrichmentDirectory = await createEnrichment({
    outputRoot,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
    sourceRunId: initialRunId,
    enrichmentId: firstEnrichmentId,
    modules: ['clusters'],
    clusters: [cluster('cluster-1', 0, 'alpha tool', [[0, 'alpha tool'], [1, 'beta tool']])],
    representatives: [representativeSet('cluster-1', 0, 'alpha tool')],
  });

  const appendInput = join(outputRoot, 'append.csv');
  await writeFile(appendInput, 'keyword\nbeta tool\ngamma tool\n', 'utf8');
  const append = await prepareResearchAppend({
    outputRoot,
    targetRunId: initialRunId,
    seedsPath: appendInput,
    seeds: [
      { keyword: 'beta tool', normalizedKeyword: 'beta tool', sourceRows: [2] },
      { keyword: 'gamma tool', normalizedKeyword: 'gamma tool', sourceRows: [3] },
    ],
    now: () => new Date('2026-08-31T01:00:00.000Z'),
  });
  assert.equal(append.changed, true);

  const currentLocation = await resolveRunLocation(outputRoot, append.currentRunId);
  const currentStore = RunStore.open(join(currentLocation.discoveryDirectory, 'run.sqlite'));
  try {
    completeKeyword(currentStore, append.currentRunId, 2);
    currentStore.setRunState(append.currentRunId, 'completed', {
      updatedAt: '2026-08-31T01:01:00.000Z',
    });
  } finally {
    currentStore.close();
  }

  const secondEnrichmentId = 'enrichment_v22_integration_2';
  await createEnrichment({
    outputRoot,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: currentLocation.discoveryDirectory,
    sourceRunId: append.currentRunId,
    enrichmentId: secondEnrichmentId,
    modules: ['clusters', 'pages'],
    clusters: [
      cluster('cluster-1', 0, 'alpha tool', [[0, 'alpha tool'], [2, 'gamma tool']]),
      cluster('cluster-2', 1, 'beta tool', [[1, 'beta tool']]),
    ],
    representatives: [
      representativeSet('cluster-1', 2, 'gamma tool'),
      representativeSet('cluster-2', 1, 'beta tool'),
    ],
  });

  const status = await buildResearchStatus({ outputRoot, targetRunId: initialRunId });
  assert.equal(status.researchId, initialRunId);
  assert.equal(status.discovery.generation, 2);
  assert.equal(status.discovery.runId, append.currentRunId);
  assert.equal(status.currentEnrichmentId, secondEnrichmentId);
  assert.equal(status.enrichments.length, 2);
  assert.equal(status.enrichments[0]?.isForCurrentDiscovery, false);
  assert.equal(status.enrichments[1]?.isLatestForCurrentDiscovery, true);
  assert.deepEqual(status.evidenceCoverage?.representativeUrlCoverage, {
    numerator: 2,
    denominator: 2,
    ratio: 1,
  });
  assert.equal(
    status.evidenceCoverage?.warnings.some((warning) => warning.code === 'ENTRANT_COHORT_NOT_COLLECTED'),
    true,
  );
  assert.equal(status.nextAction.code, 'run_finalization');

  const discoveryDiff = await buildResearchGenerationDiff({
    outputRoot,
    targetRunId: initialRunId,
    from: 'discovery:1',
    to: 'discovery:2',
  });
  assert.deepEqual(discoveryDiff.discovery?.keywords.added, [{
    normalizedKeyword: 'gamma tool',
    keyword: 'gamma tool',
    status: 'completed',
  }]);
  assert.deepEqual(discoveryDiff.discovery?.googleSerpCoverage.from, {
    numerator: 2,
    denominator: 2,
    ratio: 1,
  });
  assert.deepEqual(discoveryDiff.discovery?.googleSerpCoverage.to, {
    numerator: 3,
    denominator: 3,
    ratio: 1,
  });

  const enrichmentDiff = await buildResearchGenerationDiff({
    outputRoot,
    targetRunId: initialRunId,
    from: 'enrichment:1',
    to: 'enrichment:2',
  });
  assert.deepEqual(enrichmentDiff.enrichment?.modules, { added: ['pages'], removed: [] });
  assert.deepEqual(enrichmentDiff.enrichment?.clusters.added.map((row) => row.clusterId), ['cluster-2']);
  assert.deepEqual(enrichmentDiff.enrichment?.clusters.changed, [{
    clusterId: 'cluster-1',
    canonicalKeywordFrom: 'alpha tool',
    canonicalKeywordTo: 'alpha tool',
    addedMembers: ['gamma tool'],
    removedMembers: ['beta tool'],
  }]);
  assert.deepEqual(enrichmentDiff.enrichment?.representatives, [
    { clusterId: 'cluster-1', from: ['alpha tool'], to: ['gamma tool'] },
    { clusterId: 'cluster-2', from: null, to: ['beta tool'] },
  ]);

  const immutableDiscovery = RunStore.openReadOnly(join(location.discoveryDirectory, 'run.sqlite'));
  try {
    assert.equal(immutableDiscovery.loadRun(initialRunId)?.state, 'completed');
    assert.deepEqual(
      immutableDiscovery.loadKeywords(initialRunId).map((row) => row.normalizedKeyword),
      ['alpha tool', 'beta tool'],
    );
  } finally {
    immutableDiscovery.close();
  }

  const immutableEnrichment = RunStore.openReadOnly(join(firstEnrichmentDirectory, 'enrichment.sqlite'));
  try {
    assert.deepEqual(
      immutableEnrichment.loadKeywordClusters(firstEnrichmentId)[0]?.members.map((row) => row.normalizedKeyword),
      ['alpha tool', 'beta tool'],
    );
    assert.deepEqual(
      loadRepresentativeQueryState(immutableEnrichment, firstEnrichmentId)?.sets[0]?.representatives.map((row) => row.normalizedKeyword),
      ['alpha tool'],
    );
  } finally {
    immutableEnrichment.close();
  }
});
