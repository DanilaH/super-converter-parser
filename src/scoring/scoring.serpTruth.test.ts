import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidates, type DrThresholds } from './scoring.js';
import type { SerpResult } from '../google/serp.js';
import type { KeywordRecord } from '../runs/run.js';

const THRESHOLDS: DrThresholds = { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 };

function google(
  serpStatus: NonNullable<KeywordRecord['google']>['serpStatus'],
  error: NonNullable<KeywordRecord['google']>['serpError'] = null,
): KeywordRecord['google'] {
  return {
    hl: 'en',
    gl: 'us',
    pageUrl: 'https://google.com/search?q=x',
    detectedLocation: null,
    geoWarning: false,
    serpStatus,
    serpError: error,
  };
}

function row(keywordIdx: number): SerpResult {
  return {
    keyword: 'k',
    keywordIdx,
    position: 1,
    title: 'result',
    url: 'https://example.com/page',
    hostname: 'example.com',
    registrableDomain: 'example.com',
    dr: 12,
    drStatus: 'ok',
    resultType: 'organic',
  };
}

test('partial keyword with Surfer demand but Google parse error is unscored and has no fake SERP numerics', () => {
  const [candidate] = buildCandidates(
    [{
      idx: 0,
      keyword: 'k',
      normalizedKeyword: 'k',
      status: 'partial',
      error: { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'bad serp' },
      surfer: { volume: 1000, cpc: 2 },
      google: google('parse_error', { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'bad serp' }),
    }],
    [],
    THRESHOLDS,
  );

  assert.equal(candidate?.serpStatus, 'parse_error');
  assert.equal(candidate?.organicResultCount, null);
  assert.equal(candidate?.uniqueDomains, null);
  assert.equal(candidate?.serpDiversity, null);
  assert.equal(candidate?.score, null);
  assert.equal(candidate?.tier, null);
});

test('genuine empty SERP keeps numeric zero and remains trustworthy for scoring', () => {
  const [candidate] = buildCandidates(
    [{
      idx: 0,
      keyword: 'k',
      normalizedKeyword: 'k',
      status: 'completed',
      error: null,
      surfer: { volume: 1000, cpc: 2 },
      google: google('empty'),
    }],
    [],
    THRESHOLDS,
  );

  assert.equal(candidate?.serpStatus, 'empty');
  assert.equal(candidate?.organicResultCount, 0);
  assert.equal(candidate?.uniqueDomains, 0);
  assert.equal(candidate?.serpDiversity, 0);
  assert.notEqual(candidate?.score, null);
});

test('trustworthy Google rows remain scoreable even when Surfer failed first', () => {
  const [candidate] = buildCandidates(
    [{
      idx: 3,
      keyword: 'k',
      normalizedKeyword: 'k',
      status: 'partial',
      error: { code: 'SURFER_PARSE_ERROR', message: 'bad surfer' },
      surfer: null,
      google: google('ok'),
    }],
    [row(3)],
    THRESHOLDS,
  );

  assert.equal(candidate?.serpStatus, 'ok');
  assert.equal(candidate?.organicResultCount, 1);
  assert.equal(candidate?.uniqueDomains, 1);
  assert.notEqual(candidate?.score, null);
});
