import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeywordCluster, PairwiseComparison } from './types.js';
import {
  REPRESENTATIVE_QUERY_SET_VERSION,
  selectRepresentativeQueries,
} from './representativeQueries.js';

function cluster(
  ids: number[],
  volumes: Record<number, number | null> = {},
  normalized: Record<number, string> = {},
): KeywordCluster {
  return {
    clusterId: 'cluster-1',
    canonicalKeywordIdx: ids[0] ?? null,
    canonicalKeyword: ids.length > 0 ? `q${ids[0]}` : '',
    members: ids.map((keywordIdx) => ({
      keywordIdx,
      keyword: `q${keywordIdx}`,
      normalizedKeyword: normalized[keywordIdx] ?? `q${keywordIdx}`,
      volume: volumes[keywordIdx] ?? null,
      serpSize: 10,
    })),
    representativeDomains: [],
    medianVolume: null,
    averageVolume: null,
    memberCount: ids.length,
    cohesion: null,
  };
}

function pair(a: number, b: number, urlJaccard: number, domainJaccard: number): PairwiseComparison {
  return {
    keywordAIdx: Math.min(a, b),
    keywordBIdx: Math.max(a, b),
    keywordA: `q${Math.min(a, b)}`,
    keywordB: `q${Math.max(a, b)}`,
    intersectionCount: 0,
    unionCount: 0,
    jaccard: domainJaccard,
    sharedDomains: [],
    sharedUrls: [],
    urlIntersectionCount: 0,
    urlUnionCount: 0,
    urlJaccard,
    domainIntersectionCount: 0,
    domainUnionCount: 0,
    domainJaccard,
    classification: 'strong',
    isEdge: true,
  };
}

function completePairs(ids: number[]): PairwiseComparison[] {
  const pairs: PairwiseComparison[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      pairs.push(pair(ids[i]!, ids[j]!, 1, 1));
    }
  }
  return pairs;
}

function urls(entries: Record<number, string[]>): Map<number, string[]> {
  return new Map(Object.entries(entries).map(([id, rows]) => [Number(id), rows]));
}

test('selects URL medoid first, using domain centrality only as a tie-break', () => {
  const result = selectRepresentativeQueries({
    cluster: cluster([1, 2, 3]),
    pairs: [
      pair(1, 2, 0.8, 0.2),
      pair(1, 3, 0.8, 0.2),
      pair(2, 3, 0.1, 1.0),
    ],
    memberUrls: urls({
      1: ['https://a.test/1'],
      2: ['https://b.test/1'],
      3: ['https://c.test/1'],
    }),
  });

  assert.equal(result.representatives[0]?.keywordIdx, 1);
  assert.equal(result.representatives[0]?.selectionReason, 'medoid');
});

test('selects one distinct high-demand query after the medoid', () => {
  const result = selectRepresentativeQueries({
    cluster: cluster([1, 2, 3, 4], { 1: 100, 2: 500, 3: 900, 4: 700 }),
    pairs: completePairs([1, 2, 3, 4]),
    memberUrls: urls({
      1: ['https://shared.test/tool'],
      2: ['https://shared.test/tool'],
      3: ['https://shared.test/tool'],
      4: ['https://shared.test/tool'],
    }),
  });

  assert.equal(result.representatives[0]?.keywordIdx, 1);
  assert.equal(result.representatives[1]?.keywordIdx, 3);
  assert.equal(result.representatives[1]?.selectionReason, 'high_demand');
});

test('greedy expansion maximizes newly covered normalized ranking URLs', () => {
  const result = selectRepresentativeQueries({
    cluster: cluster([1, 2, 3, 4], { 2: 100 }),
    pairs: completePairs([1, 2, 3, 4]),
    memberUrls: urls({
      1: ['https://a.test/tool', 'https://b.test/tool'],
      2: ['https://a.test/tool'],
      3: ['https://c.test/tool', 'https://d.test/tool', 'https://e.test/tool'],
      4: ['https://f.test/tool'],
    }),
  });

  assert.deepEqual(result.representativeKeywordIds.slice(0, 3), [1, 2, 3]);
  assert.equal(result.representatives[2]?.selectionReason, 'coverage_expansion');
  assert.equal(result.representatives[2]?.coverageGain, 3);
  assert.equal(result.coveredUrlCount, 6);
  assert.equal(result.clusterUrlCount, 6);
});

test('coverage tie-break is source keyword idx, not keyword text or volume', () => {
  const result = selectRepresentativeQueries({
    cluster: cluster([10, 20, 30], { 20: null, 30: null }),
    pairs: completePairs([10, 20, 30]),
    memberUrls: urls({
      10: ['https://a.test/tool'],
      20: ['https://b.test/tool'],
      30: ['https://c.test/tool'],
    }),
  });

  assert.deepEqual(result.representativeKeywordIds, [10, 20, 30]);
  assert.equal(result.representatives[1]?.selectionReason, 'coverage_expansion');
});

test('normalized keyword duplicates are deferred while a distinct member remains', () => {
  const result = selectRepresentativeQueries({
    cluster: cluster(
      [1, 2, 3],
      { 2: 1000, 3: 500 },
      { 1: 'same query', 2: 'same query', 3: 'different query' },
    ),
    pairs: completePairs([1, 2, 3]),
    memberUrls: urls({
      1: ['https://a.test/tool'],
      2: ['https://b.test/tool'],
      3: ['https://c.test/tool'],
    }),
  });

  assert.equal(result.representatives[0]?.keywordIdx, 1);
  assert.equal(result.representatives[1]?.keywordIdx, 3);
  assert.equal(result.representatives[1]?.selectionReason, 'high_demand');
  assert.equal(result.representatives[2]?.keywordIdx, 2);
});

test('default target is five but small clusters retain every member', () => {
  const small = selectRepresentativeQueries({
    cluster: cluster([1, 2]),
    pairs: completePairs([1, 2]),
    memberUrls: urls({ 1: ['https://a.test/'], 2: ['https://b.test/'] }),
  });
  assert.equal(small.targetCount, 2);
  assert.deepEqual(small.representativeKeywordIds, [1, 2]);

  const largeIds = [1, 2, 3, 4, 5, 6, 7];
  const large = selectRepresentativeQueries({
    cluster: cluster(largeIds),
    pairs: completePairs(largeIds),
    memberUrls: urls(Object.fromEntries(largeIds.map((id) => [id, [`https://d${id}.test/tool`]]))),
  });
  assert.equal(large.targetCount, 5);
  assert.equal(large.representativeKeywordIds.length, 5);
});

test('manual override replaces auto selection, preserves order and reports its explicit effective target', () => {
  const ids = [1, 2, 3, 4];
  const result = selectRepresentativeQueries({
    cluster: cluster(ids),
    pairs: completePairs(ids),
    memberUrls: urls({
      1: ['https://a.test/'],
      2: ['https://b.test/'],
      3: ['https://c.test/'],
      4: ['https://d.test/'],
    }),
    config: {
      setVersion: REPRESENTATIVE_QUERY_SET_VERSION,
      overrides: [{ clusterId: 'cluster-1', keywordIds: [4, 2], reason: 'manual intent review' }],
    },
  });

  assert.deepEqual(result.representativeKeywordIds, [4, 2]);
  assert.equal(result.targetCount, 2);
  assert.equal(result.manualOverride, true);
  assert.equal(result.manualOverrideReason, 'manual intent review');
  assert.equal(result.representatives.every((row) => row.selectionReason === 'manual_override'), true);
});

test('manual override rejects a keyword outside the cluster after validating cluster evidence', () => {
  const ids = [1, 2, 3];
  assert.throws(
    () => selectRepresentativeQueries({
      cluster: cluster(ids),
      pairs: completePairs(ids),
      memberUrls: urls({
        1: ['https://a.test/'],
        2: ['https://b.test/'],
        3: ['https://c.test/'],
      }),
      config: {
        overrides: [{ clusterId: 'cluster-1', keywordIds: [99], reason: 'reviewed' }],
      },
    }),
    /not a cluster member/,
  );
});

test('URL coverage uses the same conservative clustering URL identity', () => {
  const result = selectRepresentativeQueries({
    cluster: cluster([1, 2, 3]),
    pairs: completePairs([1, 2, 3]),
    memberUrls: urls({
      1: ['https://www.example.test/tool/?utm_source=a'],
      2: ['http://example.test/tool?utm_medium=b'],
      3: ['https://example.test/other'],
    }),
  });

  assert.equal(result.clusterUrlCount, 2);
});
