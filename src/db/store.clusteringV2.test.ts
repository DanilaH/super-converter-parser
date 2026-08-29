import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStore, SCHEMA_VERSION } from './store.js';

const CONFIG = {
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
  pairCount: 1,
  urlJaccard: { min: 0.2, median: 0.2, mean: 0.2 },
  domainJaccard: { min: 1 / 3, median: 1 / 3, mean: 1 / 3 },
};

function createRun(store: RunStore): void {
  store.createEnrichmentRun({
    enrichmentId: 'enr-v2',
    sourceRunId: 'source-v2',
    modules: ['clusters'],
    config: JSON.stringify({ clusters: CONFIG }),
    sourceRunDirectory: 'runs/source-v2',
    enrichmentDirectory: 'enrichments/enr-v2',
  });
}

test('schema v17 round-trips clustering-v2 pair and cohesion evidence', () => {
  const store = RunStore.openInMemory();
  assert.equal(store.version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 17);
  createRun(store);

  store.saveKeywordClusters('enr-v2', [{
    clusterId: 'cluster-1',
    canonicalKeywordIdx: 17,
    canonicalKeyword: 'speaker test',
    members: [
      { keywordIdx: 17, keyword: 'speaker test', normalizedKeyword: 'speaker test', volume: 1000, serpSize: 8 },
      { keywordIdx: 20, keyword: 'audio test', normalizedKeyword: 'audio test', volume: 900, serpSize: 10 },
    ],
    representativeDomains: ['example.com', 'example.net'],
    medianVolume: 950,
    averageVolume: 950,
    cohesion: COHESION,
    algorithmVersion: '2.0.0',
    config: CONFIG,
  }]);

  store.saveEnrichmentPairs('enr-v2', [{
    keywordAIdx: 17,
    keywordBIdx: 20,
    keywordA: 'speaker test',
    keywordB: 'audio test',
    intersectionCount: 4,
    unionCount: 12,
    jaccard: 4 / 12,
    sharedDomains: ['a.test', 'b.test', 'c.test', 'd.test'],
    sharedUrls: ['a.test/tool', 'b.test/tool', 'c.test/tool'],
    urlIntersectionCount: 3,
    urlUnionCount: 15,
    urlJaccard: 3 / 15,
    domainIntersectionCount: 4,
    domainUnionCount: 12,
    domainJaccard: 4 / 12,
    classification: 'strong',
    isEdge: true,
  }]);

  assert.deepEqual(store.loadKeywordClusters('enr-v2')[0]?.cohesion, COHESION);
  assert.deepEqual(store.loadEnrichmentPairs('enr-v2')[0], {
    keywordAIdx: 17,
    keywordBIdx: 20,
    keywordA: 'speaker test',
    keywordB: 'audio test',
    intersectionCount: 4,
    unionCount: 12,
    jaccard: 4 / 12,
    sharedDomains: ['a.test', 'b.test', 'c.test', 'd.test'],
    domainIntersectionCount: 4,
    domainUnionCount: 12,
    domainJaccard: 4 / 12,
    classification: 'strong',
    sharedUrls: ['a.test/tool', 'b.test/tool', 'c.test/tool'],
    urlIntersectionCount: 3,
    urlUnionCount: 15,
    urlJaccard: 3 / 15,
    isEdge: true,
  });

  store.close();
});

test('new pair writes reject missing clustering-v2 evidence instead of fabricating it', () => {
  const store = RunStore.openInMemory();
  createRun(store);

  assert.throws(
    () => store.saveEnrichmentPairs('enr-v2', [{
      keywordAIdx: 1,
      keywordBIdx: 2,
      keywordA: 'one',
      keywordB: 'two',
      intersectionCount: 3,
      unionCount: 5,
      jaccard: 0.6,
      sharedDomains: ['a.test', 'b.test', 'c.test'],
      isEdge: true,
    }]),
    /missing clustering-v2 URL\/domain evidence/,
  );

  store.close();
});
