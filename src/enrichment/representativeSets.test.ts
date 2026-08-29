import test from 'node:test';
import assert from 'node:assert/strict';
import type { SerpResult } from '../google/serp.js';
import type { KeywordCluster } from './types.js';
import { buildRepresentativeQuerySets } from './representativeSets.js';

function cluster(clusterId: string, keywordIdx: number): KeywordCluster {
  const keyword = `q${keywordIdx}`;
  return {
    clusterId,
    canonicalKeywordIdx: keywordIdx,
    canonicalKeyword: keyword,
    members: [{
      keywordIdx,
      keyword,
      normalizedKeyword: keyword,
      volume: null,
      serpSize: 3,
    }],
    representativeDomains: [],
    medianVolume: null,
    averageVolume: null,
    memberCount: 1,
    cohesion: { pairCount: 0, urlJaccard: null, domainJaccard: null },
  };
}

function serp(keywordIdx: number, position: number, url: string): SerpResult {
  return {
    keyword: `q${keywordIdx}`,
    keywordIdx,
    position,
    title: `result ${position}`,
    url,
    hostname: new URL(url).hostname,
    registrableDomain: new URL(url).hostname,
    dr: null,
    drStatus: null,
    drError: null,
    resultType: 'organic',
  };
}

test('representative coverage applies topN to raw ranked rows before URL identity dedupe', () => {
  const sets = buildRepresentativeQuerySets({
    clusters: [cluster('cluster-1', 1)],
    pairs: [],
    topN: 2,
    serpRows: [
      serp(1, 1, 'https://example.test/tool?utm_source=one'),
      serp(1, 2, 'https://www.example.test/tool?utm_source=two'),
      serp(1, 3, 'https://late.test/tool'),
    ],
  });

  assert.equal(sets[0]?.clusterUrlCount, 1);
  assert.equal(sets[0]?.coveredUrlCount, 1);
});

test('sets are emitted in numeric cluster order for stable artifacts', () => {
  const sets = buildRepresentativeQuerySets({
    clusters: [cluster('cluster-10', 10), cluster('cluster-2', 2), cluster('cluster-1', 1)],
    pairs: [],
    topN: 10,
    serpRows: [
      serp(10, 1, 'https://ten.test/tool'),
      serp(2, 1, 'https://two.test/tool'),
      serp(1, 1, 'https://one.test/tool'),
    ],
  });

  assert.deepEqual(sets.map((set) => set.clusterId), ['cluster-1', 'cluster-2', 'cluster-10']);
});

test('unknown manual override cluster is rejected instead of being silently ignored', () => {
  assert.throws(
    () => buildRepresentativeQuerySets({
      clusters: [cluster('cluster-1', 1)],
      pairs: [],
      topN: 10,
      serpRows: [serp(1, 1, 'https://one.test/tool')],
      config: {
        targetCount: 5,
        setVersion: '1.0.0',
        overrides: [{
          clusterId: 'cluster-99',
          keywordIds: [1],
          reason: 'manual review',
        }],
      },
    }),
    /unknown cluster\(s\): cluster-99/,
  );
});
