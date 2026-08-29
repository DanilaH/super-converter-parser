import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterKeywords, CLUSTERING_ALGORITHM_VERSION, type ClusteringInput } from './clustering.js';
import type { ClusteringConfig } from './types.js';

const CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: {
    minSharedDomains: 1,
    minJaccard: 0,
    minSharedUrls: 1,
    minUrlJaccard: 0,
  },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
};

test('fresh pair relations use the same idx ordering as SQLite resume reads', () => {
  const inputs: ClusteringInput[] = [
    { keywordIdx: 30, keyword: 'Alpha', normalizedKeyword: 'alpha', volume: 300, domains: ['shared.com'], urls: ['https://shared.com/tool'] },
    { keywordIdx: 10, keyword: 'Zulu', normalizedKeyword: 'zulu', volume: 100, domains: ['shared.com'], urls: ['https://shared.com/tool'] },
    { keywordIdx: 20, keyword: 'Mike', normalizedKeyword: 'mike', volume: 200, domains: ['shared.com'], urls: ['https://shared.com/tool'] },
  ];

  const result = clusterKeywords(inputs, CONFIG);

  assert.deepEqual(
    result.pairs.map((pair) => [pair.keywordAIdx, pair.keywordBIdx]),
    [[10, 20], [10, 30], [20, 30]],
  );
  assert.deepEqual(
    result.pairs.map((pair) => [pair.keywordA, pair.keywordB]),
    [['zulu', 'mike'], ['zulu', 'alpha'], ['mike', 'alpha']],
  );
});

test('fresh exclusions use source idx ordering like SQLite resume reads', () => {
  const inputs: ClusteringInput[] = [
    { keywordIdx: 30, keyword: 'Alpha', normalizedKeyword: 'alpha', volume: 300, domains: [], urls: [] },
    { keywordIdx: 10, keyword: 'Zulu', normalizedKeyword: 'zulu', volume: 100, domains: [], urls: [] },
    { keywordIdx: 20, keyword: 'Mike', normalizedKeyword: 'mike', volume: 200, domains: [], urls: [] },
  ];

  const result = clusterKeywords(inputs, CONFIG);

  assert.deepEqual(result.exclusions.map((row) => row.keywordIdx), [10, 20, 30]);
});
