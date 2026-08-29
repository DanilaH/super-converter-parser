import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeywordCluster } from './types.js';
import { buildRepresentativeQuerySets } from './representativeSets.js';

const CLUSTER: KeywordCluster = {
  clusterId: 'cluster-1',
  canonicalKeywordIdx: 1,
  canonicalKeyword: 'one',
  members: [{
    keywordIdx: 1,
    keyword: 'one',
    normalizedKeyword: 'one',
    volume: 100,
    serpSize: 3,
  }],
  representativeDomains: ['one.test'],
  medianVolume: 100,
  averageVolume: 100,
  memberCount: 1,
  cohesion: { pairCount: 0, urlJaccard: null, domainJaccard: null },
};

test('cluster member missing from source organic SERP fails loudly', () => {
  assert.throws(
    () => buildRepresentativeQuerySets({
      clusters: [CLUSTER],
      pairs: [],
      serpRows: [],
      topN: 10,
    }),
    /member 1 has no organic source SERP rows/,
  );
});

test('duplicate cluster ids are rejected before selection or persistence', () => {
  assert.throws(
    () => buildRepresentativeQuerySets({
      clusters: [CLUSTER, { ...CLUSTER }],
      pairs: [],
      serpRows: [],
      topN: 10,
    }),
    /Duplicate cluster id/,
  );
});
