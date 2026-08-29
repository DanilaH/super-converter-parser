import test from 'node:test';
import assert from 'node:assert/strict';
import type { KeywordCluster } from './types.js';
import { selectRepresentativeQueries } from './representativeQueries.js';

const CLUSTER: KeywordCluster = {
  clusterId: 'cluster-1',
  canonicalKeywordIdx: 1,
  canonicalKeyword: 'one',
  members: [
    { keywordIdx: 1, keyword: 'one', normalizedKeyword: 'one', volume: 100, serpSize: 3 },
    { keywordIdx: 2, keyword: 'two', normalizedKeyword: 'two', volume: 200, serpSize: 3 },
  ],
  representativeDomains: [],
  medianVolume: 150,
  averageVolume: 150,
  memberCount: 2,
  cohesion: null,
};

test('multi-member representative selection refuses missing clustering-v2 pair evidence', () => {
  assert.throws(
    () => selectRepresentativeQueries({
      cluster: CLUSTER,
      pairs: [],
      memberUrls: new Map([
        [1, ['https://one.test/tool']],
        [2, ['https://two.test/tool']],
      ]),
    }),
    /missing clustering-v2 pair evidence for keyword ids 1 and 2/,
  );
});

test('manual override does not bypass corrupted pair evidence', () => {
  assert.throws(
    () => selectRepresentativeQueries({
      cluster: CLUSTER,
      pairs: [],
      memberUrls: new Map([
        [1, ['https://one.test/tool']],
        [2, ['https://two.test/tool']],
      ]),
      config: {
        overrides: [{ clusterId: 'cluster-1', keywordIds: [1], reason: 'reviewed' }],
      },
    }),
    /missing clustering-v2 pair evidence/,
  );
});
