import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKeywordCacheKey,
  buildRelatedCacheKey,
  buildDomainCacheKey,
  normalizeDomain,
  type CacheIdentity,
} from './keys.js';

const IDENTITY: CacheIdentity = {
  market: 'US',
  hl: 'en',
  gl: 'us',
  topN: 10,
  surferParserVersion: '1.0.0',
  googleParserVersion: '1.2.0',
};

test('keyword cache keys are deterministic', () => {
  assert.equal(
    buildKeywordCacheKey('compare lists', IDENTITY),
    buildKeywordCacheKey('compare lists', IDENTITY),
  );
});

test('keyword cache keys differ across keywords', () => {
  assert.notEqual(
    buildKeywordCacheKey('compare lists', IDENTITY),
    buildKeywordCacheKey('best office chairs', IDENTITY),
  );
});

test('keyword cache keys differ when any identity field changes', () => {
  const base = buildKeywordCacheKey('compare lists', IDENTITY);
  const cases: Array<[string, Partial<CacheIdentity>]> = [
    ['market', { market: 'DE' }],
    ['hl', { hl: 'de' }],
    ['gl', { gl: 'de' }],
    ['topN', { topN: 5 }],
    ['surfer parser version', { surferParserVersion: '1.1.0' }],
    ['google parser version', { googleParserVersion: '1.3.0' }],
  ];
  for (const [label, change] of cases) {
    assert.notEqual(buildKeywordCacheKey('compare lists', { ...IDENTITY, ...change }), base, label);
  }
});

test('normalizeDomain trims and lowercases', () => {
  assert.equal(normalizeDomain('  Example.COM '), 'example.com');
});

test('domain cache keys are deterministic and case-insensitive', () => {
  assert.equal(buildDomainCacheKey('example.com'), buildDomainCacheKey('Example.COM'));
  assert.notEqual(buildDomainCacheKey('example.com'), buildDomainCacheKey('other.com'));
});

test('related cache keys are deterministic and scoped per keyword', () => {
  assert.equal(
    buildRelatedCacheKey('compare lists', IDENTITY),
    buildRelatedCacheKey('compare lists', IDENTITY),
  );
  assert.notEqual(
    buildRelatedCacheKey('compare lists', IDENTITY),
    buildRelatedCacheKey('best office chairs', IDENTITY),
  );
});

test('related cache keys differ when any identity field changes', () => {
  const base = buildRelatedCacheKey('compare lists', IDENTITY);
  const cases: Array<[string, Partial<CacheIdentity>]> = [
    ['market', { market: 'DE' }],
    ['hl', { hl: 'de' }],
    ['gl', { gl: 'de' }],
    ['topN', { topN: 5 }],
    ['surfer parser version', { surferParserVersion: '1.1.0' }],
    ['google parser version', { googleParserVersion: '1.3.0' }],
  ];
  for (const [label, change] of cases) {
    assert.notEqual(buildRelatedCacheKey('compare lists', { ...IDENTITY, ...change }), base, label);
  }
});

test('related keys never collide with keyword or domain keys', () => {
  const keyword = buildKeywordCacheKey('compare lists', IDENTITY);
  const related = buildRelatedCacheKey('compare lists', IDENTITY);
  const domain = buildDomainCacheKey('compare lists');
  assert.notEqual(related, keyword);
  assert.notEqual(related, domain);
});
