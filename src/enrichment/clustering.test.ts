import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterKeywords, CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig, type ClusteringInput } from './clustering.js';

const DEFAULT_CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
};

function withIds(inputs: Array<Omit<ClusteringInput, 'keywordIdx'>>): ClusteringInput[] {
  return inputs.map((input, keywordIdx) => ({ ...input, keywordIdx }));
}

test('exact match: identical domain sets merge into one cluster', () => {
  const inputs = withIds([
    { keyword: 'compare lists', normalizedKeyword: 'compare lists', volume: 1000, domains: ['a.com', 'b.com', 'c.com', 'd.com'] },
    { keyword: 'list comparison', normalizedKeyword: 'list comparison', volume: 500, domains: ['a.com', 'b.com', 'c.com', 'd.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]!.memberCount, 2);
  assert.equal(result.edgeCount, 1);
});

test('partial overlap: Jaccard threshold gates edge creation', () => {
  const inputs = withIds([
    { keyword: 'json diff', normalizedKeyword: 'json diff', volume: 800, domains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'] },
    { keyword: 'json compare', normalizedKeyword: 'json compare', volume: 600, domains: ['a.com', 'b.com', 'c.com', 'x.com', 'y.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]!.memberCount, 2);
});

test('below Jaccard threshold: no edge, two singletons', () => {
  const inputs = withIds([
    { keyword: 'json diff', normalizedKeyword: 'json diff', volume: 800, domains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'] },
    { keyword: 'csv tools', normalizedKeyword: 'csv tools', volume: 400, domains: ['a.com', 'x.com', 'y.com', 'z.com', 'w.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters.length, 2);
  assert.equal(result.edgeCount, 0);
});

test('transitive component: A-B and B-C implies A-B-C cluster', () => {
  const inputs = withIds([
    { keyword: 'a', normalizedKeyword: 'a', volume: 100, domains: ['x.com', 'y.com', 'z.com', 'p.com'] },
    { keyword: 'b', normalizedKeyword: 'b', volume: 200, domains: ['x.com', 'y.com', 'z.com', 'q.com'] },
    { keyword: 'c', normalizedKeyword: 'c', volume: 300, domains: ['x.com', 'y.com', 'z.com', 'r.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]!.memberCount, 3);
});

test('singleton: keyword with no edges forms its own cluster', () => {
  const inputs = withIds([
    { keyword: 'unique query', normalizedKeyword: 'unique query', volume: 50, domains: ['only.com', 'unique.com', 'solo.com'] },
    { keyword: 'another query', normalizedKeyword: 'another query', volume: 60, domains: ['other.com', 'different.com', 'separate.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters.length, 2);
  for (const cluster of result.clusters) {
    assert.equal(cluster.memberCount, 1);
  }
});

test('missing SERP: keywords without domains are excluded with reason', () => {
  const inputs = withIds([
    { keyword: 'has serp', normalizedKeyword: 'has serp', volume: 100, domains: ['a.com', 'b.com', 'c.com'] },
    { keyword: 'no serp', normalizedKeyword: 'no serp', volume: 200, domains: [] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.inputCount, 2);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]!.members[0]!.normalizedKeyword, 'has serp');
  assert.equal(result.exclusions[0]?.keywordIdx, 1);
});

test('null volume: does not break clustering and tie-breaks last', () => {
  const inputs = withIds([
    { keyword: 'null vol', normalizedKeyword: 'null vol', volume: null, domains: ['a.com', 'b.com', 'c.com'] },
    { keyword: 'has vol', normalizedKeyword: 'has vol', volume: 500, domains: ['a.com', 'b.com', 'c.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]!.canonicalKeyword, 'has vol');
  assert.equal(result.clusters[0]!.canonicalKeywordIdx, 1);
  assert.equal(result.clusters[0]!.medianVolume, 500);
});

test('canonical keyword: highest in-cluster Jaccard sum wins', () => {
  const inputs = withIds([
    { keyword: 'center', normalizedKeyword: 'center', volume: 100, domains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'] },
    { keyword: 'leaf1', normalizedKeyword: 'leaf1', volume: 200, domains: ['a.com', 'b.com', 'c.com'] },
    { keyword: 'leaf2', normalizedKeyword: 'leaf2', volume: 300, domains: ['c.com', 'd.com', 'e.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]!.canonicalKeyword, 'center');
  assert.equal(result.clusters[0]!.canonicalKeywordIdx, 0);
});

test('tie-break by volume when Jaccard sums are equal', () => {
  const inputs = withIds([
    { keyword: 'low vol', normalizedKeyword: 'low vol', volume: 100, domains: ['a.com', 'b.com', 'c.com'] },
    { keyword: 'high vol', normalizedKeyword: 'high vol', volume: 900, domains: ['a.com', 'b.com', 'c.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters[0]!.canonicalKeyword, 'high vol');
});

test('tie-break by lexical order when volume also ties', () => {
  const inputs = withIds([
    { keyword: 'beta', normalizedKeyword: 'beta', volume: 500, domains: ['a.com', 'b.com', 'c.com'] },
    { keyword: 'alpha', normalizedKeyword: 'alpha', volume: 500, domains: ['a.com', 'b.com', 'c.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters[0]!.canonicalKeyword, 'alpha');
});

test('representative domains ordered by frequency then average rank', () => {
  const inputs = withIds([
    { keyword: 'q1', normalizedKeyword: 'q1', volume: 100, domains: ['first.com', 'second.com', 'third.com'] },
    { keyword: 'q2', normalizedKeyword: 'q2', volume: 200, domains: ['first.com', 'second.com', 'third.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.deepEqual(result.clusters[0]!.representativeDomains, ['first.com', 'second.com', 'third.com']);
});

test('configurable thresholds change results', () => {
  const inputs = withIds([
    { keyword: 'a', normalizedKeyword: 'a', volume: 100, domains: ['x.com', 'y.com', 'z.com'] },
    { keyword: 'b', normalizedKeyword: 'b', volume: 100, domains: ['x.com', 'y.com', 'z.com', 'w.com'] },
  ]);
  const strict = clusterKeywords(inputs, { topN: 10, edgeRule: { minSharedDomains: 4, minJaccard: 0.5 }, algorithmVersion: '1.0.0' });
  const lenient = clusterKeywords(inputs, { topN: 10, edgeRule: { minSharedDomains: 2, minJaccard: 0.2 }, algorithmVersion: '1.0.0' });
  assert.equal(strict.clusters.length, 2);
  assert.equal(lenient.clusters.length, 1);
});

test('topN truncates domain comparison window', () => {
  const inputs = withIds([
    { keyword: 'a', normalizedKeyword: 'a', volume: 100, domains: ['s1.com', 's2.com', 's3.com', 'd1.com', 'd2.com'] },
    { keyword: 'b', normalizedKeyword: 'b', volume: 100, domains: ['s1.com', 's2.com', 's3.com', 'e1.com', 'e2.com'] },
  ]);
  const top3 = clusterKeywords(inputs, { topN: 3, edgeRule: { minSharedDomains: 3, minJaccard: 0.5 }, algorithmVersion: '1.0.0' });
  const top5 = clusterKeywords(inputs, { topN: 5, edgeRule: { minSharedDomains: 3, minJaccard: 0.5 }, algorithmVersion: '1.0.0' });
  assert.equal(top3.clusters.length, 1);
  assert.equal(top5.clusters.length, 2);
});

test('result is byte-stable for same input/config', () => {
  const inputs = withIds([
    { keyword: 'json diff', normalizedKeyword: 'json diff', volume: 800, domains: ['a.com', 'b.com', 'c.com'] },
    { keyword: 'json compare', normalizedKeyword: 'json compare', volume: 600, domains: ['a.com', 'b.com', 'd.com'] },
  ]);
  const first = clusterKeywords(inputs, DEFAULT_CONFIG);
  const second = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.deepEqual(JSON.parse(JSON.stringify(first.clusters)), JSON.parse(JSON.stringify(second.clusters)));
});

test('source keyword index owns relations even when normalized text collides', () => {
  const inputs: ClusteringInput[] = [
    { keywordIdx: 10, keyword: 'JSON Diff', normalizedKeyword: 'json diff', volume: 100, domains: ['a.com', 'b.com', 'c.com'] },
    { keywordIdx: 20, keyword: 'json   diff', normalizedKeyword: 'json diff', volume: 200, domains: ['a.com', 'b.com', 'c.com'] },
  ];
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);

  assert.equal(result.clusters[0]?.memberCount, 2);
  assert.deepEqual(result.clusters[0]?.members.map((member) => member.keywordIdx).sort((a, b) => (a ?? 0) - (b ?? 0)), [10, 20]);
  assert.equal(result.pairs[0]?.keywordAIdx, 10);
  assert.equal(result.pairs[0]?.keywordBIdx, 20);
});

test('duplicate source keyword index is rejected instead of silently merging relations', () => {
  const inputs: ClusteringInput[] = [
    { keywordIdx: 7, keyword: 'one', normalizedKeyword: 'one', volume: 100, domains: ['a.com'] },
    { keywordIdx: 7, keyword: 'two', normalizedKeyword: 'two', volume: 200, domains: ['b.com'] },
  ];
  assert.throws(() => clusterKeywords(inputs, DEFAULT_CONFIG), /Duplicate source keyword index/);
});

test('empty input yields no clusters', () => {
  const result = clusterKeywords([], DEFAULT_CONFIG);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.inputCount, 0);
});

test('median volume: even count averages middle two', () => {
  const inputs = withIds([
    { keyword: 'a', normalizedKeyword: 'a', volume: 100, domains: ['x.com', 'y.com', 'z.com'] },
    { keyword: 'b', normalizedKeyword: 'b', volume: 200, domains: ['x.com', 'y.com', 'z.com'] },
  ]);
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters[0]!.medianVolume, 150);
  assert.equal(result.clusters[0]!.averageVolume, 150);
});

test('large connected cluster uses bounded pair lookup', () => {
  const inputs: ClusteringInput[] = Array.from({ length: 200 }, (_, index) => ({
    keywordIdx: index,
    keyword: `query ${String(index).padStart(3, '0')}`,
    normalizedKeyword: `query ${String(index).padStart(3, '0')}`,
    volume: index,
    domains: ['a.com', 'b.com', 'c.com'],
  }));
  const result = clusterKeywords(inputs, DEFAULT_CONFIG);
  assert.equal(result.clusters.length, 1);
  assert.equal(result.pairs.length, 19_900);
  assert.equal(result.clusters[0]?.memberCount, 200);
});
