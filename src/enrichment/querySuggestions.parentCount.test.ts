import test from 'node:test';
import assert from 'node:assert/strict';
import { countPersistedQueryParents } from './querySuggestions.js';

test('mixed legacy and idx-owned rows for one parent count once', () => {
  assert.equal(countPersistedQueryParents([
    { parentKeywordIdx: 7, normalizedParent: 'json diff' },
    { parentKeywordIdx: null, normalizedParent: 'json diff' },
    { parentKeywordIdx: null, normalizedParent: 'json diff' },
  ]), 1);
});

test('distinct idx-owned parents sharing normalized text remain distinct', () => {
  assert.equal(countPersistedQueryParents([
    { parentKeywordIdx: 7, normalizedParent: 'json diff' },
    { parentKeywordIdx: 8, normalizedParent: 'json diff' },
    { parentKeywordIdx: null, normalizedParent: 'json diff' },
  ]), 2);
});

test('legacy-only normalized parents still contribute one logical parent each', () => {
  assert.equal(countPersistedQueryParents([
    { parentKeywordIdx: 7, normalizedParent: 'json diff' },
    { parentKeywordIdx: null, normalizedParent: 'old parent' },
    { parentKeywordIdx: null, normalizedParent: 'old parent' },
  ]), 2);
});
