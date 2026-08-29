import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLUSTERING_ALGORITHM_VERSION,
  clusterKeywords,
  type ClusteringConfig,
  type ClusteringInput,
} from './clustering.js';

const CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: {
    minSharedDomains: 3,
    minJaccard: 0.3,
    minSharedUrls: 2,
    minUrlJaccard: 0.1,
  },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
};

function input(
  keywordIdx: number,
  keyword: string,
  domains: string[],
  urls: string[],
): ClusteringInput {
  return {
    keywordIdx,
    keyword,
    normalizedKeyword: keyword,
    volume: null,
    domains,
    urls,
  };
}

test('domain-only overlap is auditable evidence but not a clustering edge', () => {
  const result = clusterKeywords([
    input(
      1,
      'mouse scroll test',
      ['a.test', 'b.test', 'c.test', 'd.test', 'e.test'],
      ['https://a.test/scroll', 'https://b.test/scroll', 'https://c.test/scroll'],
    ),
    input(
      2,
      'double click test',
      ['a.test', 'b.test', 'c.test', 'd.test', 'e.test'],
      ['https://a.test/double', 'https://b.test/double', 'https://c.test/double'],
    ),
  ], CONFIG);

  assert.equal(result.edgeCount, 0);
  assert.equal(result.clusters.length, 2);
  assert.equal(result.pairs[0]?.classification, 'domain_only');
  assert.equal(result.pairs[0]?.domainIntersectionCount, 5);
  assert.equal(result.pairs[0]?.urlIntersectionCount, 0);
});

test('URL-only overlap is retained without overriding the domain gate', () => {
  const result = clusterKeywords([
    input(
      1,
      'mouse button test',
      ['a.test', 'b.test', 'left.test'],
      ['https://a.test/tool', 'https://b.test/tool', 'https://left.test/tool'],
    ),
    input(
      2,
      'double click test',
      ['a.test', 'b.test', 'right.test'],
      ['https://a.test/tool', 'https://b.test/tool', 'https://right.test/other'],
    ),
  ], CONFIG);

  assert.equal(result.edgeCount, 0);
  assert.equal(result.clusters.length, 2);
  assert.equal(result.pairs[0]?.classification, 'url_only');
  assert.equal(result.pairs[0]?.urlIntersectionCount, 2);
  assert.equal(result.pairs[0]?.domainIntersectionCount, 2);
});

test('complete-link prevents A-B-C chaining when A-C is not strong', () => {
  const result = clusterKeywords([
    input(
      1,
      'a',
      ['a.test', 'b.test', 'c.test', 'd.test'],
      ['https://a.test/1', 'https://b.test/1', 'https://c.test/1', 'https://d.test/1'],
    ),
    input(
      2,
      'b',
      ['a.test', 'b.test', 'c.test', 'e.test'],
      ['https://a.test/1', 'https://b.test/1', 'https://c.test/1', 'https://e.test/1'],
    ),
    input(
      3,
      'c',
      ['a.test', 'b.test', 'e.test', 'f.test'],
      ['https://a.test/1', 'https://b.test/1', 'https://e.test/1', 'https://f.test/1'],
    ),
  ], CONFIG);

  assert.equal(result.pairs.find((pair) => pair.keywordAIdx === 1 && pair.keywordBIdx === 2)?.classification, 'strong');
  assert.equal(result.pairs.find((pair) => pair.keywordAIdx === 2 && pair.keywordBIdx === 3)?.classification, 'strong');
  assert.equal(result.pairs.find((pair) => pair.keywordAIdx === 1 && pair.keywordBIdx === 3)?.classification, 'url_only');
  assert.deepEqual(result.clusters.map((cluster) => cluster.memberCount).sort((a, b) => b - a), [2, 1]);
  assert.equal(result.clusters.some((cluster) => cluster.memberCount === 3), false);
});

test('cluster cohesion reports every within-cluster pair', () => {
  const sharedDomains = ['a.test', 'b.test', 'c.test', 'd.test'];
  const sharedUrls = [
    'https://a.test/tool',
    'https://b.test/tool',
    'https://c.test/tool',
    'https://d.test/tool',
  ];
  const result = clusterKeywords([
    input(1, 'a', sharedDomains, sharedUrls),
    input(2, 'b', sharedDomains, sharedUrls),
    input(3, 'c', sharedDomains, sharedUrls),
  ], CONFIG);

  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0]?.cohesion, {
    pairCount: 3,
    urlJaccard: { min: 1, median: 1, mean: 1 },
    domainJaccard: { min: 1, median: 1, mean: 1 },
  });
});
