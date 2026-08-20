import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMicrosoftKeywords,
  parseVolumeBucketUpper,
  type MicrosoftRow,
} from './normalize.js';

test('parseVolumeBucketUpper extracts the upper bound of a bucket range', () => {
  assert.equal(parseVolumeBucketUpper('0 - 10'), 10);
  assert.equal(parseVolumeBucketUpper('10 - 100'), 100);
  assert.equal(parseVolumeBucketUpper('100 - 1K'), 1000);
  assert.equal(parseVolumeBucketUpper('1K - 10K'), 10000);
  assert.equal(parseVolumeBucketUpper('10K - 100K'), 100000);
  assert.equal(parseVolumeBucketUpper('100K - 1M'), 1000000);
});

test('parseVolumeBucketUpper returns null for missing or malformed buckets', () => {
  assert.equal(parseVolumeBucketUpper(null), null);
  assert.equal(parseVolumeBucketUpper(''), null);
  assert.equal(parseVolumeBucketUpper('not-a-range'), null);
  assert.equal(parseVolumeBucketUpper('1K'), null);
});

test('buildMicrosoftKeywords dedupes case-insensitively and preserves first source row', () => {
  const rows: MicrosoftRow[] = [
    {
      adGroup: 'Pdf',
      keyword: 'Compare Lists',
      volumeBucket: '1K - 10K',
      competition: null,
      cpc: null,
      rowNumber: 1,
    },
    {
      adGroup: 'List',
      keyword: 'compare lists',
      volumeBucket: '1K - 10K',
      competition: null,
      cpc: null,
      rowNumber: 5,
    },
    {
      adGroup: 'List',
      keyword: 'merge lists',
      volumeBucket: '0 - 10',
      competition: '0.33',
      cpc: 0.05,
      rowNumber: 2,
    },
  ];

  const keywords = buildMicrosoftKeywords(rows);
  assert.equal(keywords.length, 2);

  const compare = keywords.find((item) => item.normalizedKeyword === 'compare lists')!;
  assert.equal(compare.keyword, 'Compare Lists');
  assert.deepEqual(compare.sourceRows, [1, 5]);
  assert.equal(compare.microsoft.volumeBucket, '1K - 10K');
  assert.equal(compare.microsoft.volumeRaw, 10000);
  assert.equal(compare.microsoft.competition, null);
  assert.equal(compare.microsoft.cpc, null);

  const merge = keywords.find((item) => item.normalizedKeyword === 'merge lists')!;
  assert.equal(merge.microsoft.volumeBucket, '0 - 10');
  assert.equal(merge.microsoft.volumeRaw, 10);
  assert.equal(merge.microsoft.competition, '0.33');
  assert.equal(merge.microsoft.cpc, 0.05);
  assert.equal(merge.adGroup, 'List');
});
