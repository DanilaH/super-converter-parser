import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, score, buildCandidates, SCORING_VERSION, type DrThresholds } from './scoring.js';
import type { SerpResult } from '../google/serp.js';
import type { KeywordStatus } from '../runs/run.js';

const THRESHOLDS: DrThresholds = { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 };

function serp(keyword: string, position: number, domain: string, dr: number | null, drStatus: SerpResult['drStatus']): SerpResult {
  return {
    keyword,
    position,
    title: 't',
    url: `https://${domain}/${position}`,
    hostname: domain,
    registrableDomain: domain,
    dr,
    drStatus,
    resultType: 'organic',
  };
}

test('even-set median is the arithmetic mean of the middle pair', () => {
  const rows = [
    serp('k', 1, 'a.com', 10, 'ok'),
    serp('k', 2, 'b.com', 20, 'ok'),
    serp('k', 3, 'c.com', 30, 'ok'),
    serp('k', 4, 'd.com', 40, 'ok'),
  ];
  const agg = aggregate({ keyword: 'k', normalizedKeyword: 'k', surfer: null, serpRows: rows }, THRESHOLDS);
  assert.equal(agg.uniqueDomains, 4);
  assert.equal(agg.knownUniqueDomains, 4);
  assert.equal(agg.minDr, 10);
  assert.equal(agg.maxDr, 40);
  assert.equal(agg.medianDr, 25); // (20 + 30) / 2
});

test('missing DR is excluded from min/max/median but counted', () => {
  const rows = [
    serp('k', 1, 'a.com', null, 'error'),
    serp('k', 2, 'b.com', 20, 'ok'),
    serp('k', 3, 'c.com', 30, 'ok'),
  ];
  const agg = aggregate({ keyword: 'k', normalizedKeyword: 'k', surfer: null, serpRows: rows }, THRESHOLDS);
  assert.equal(agg.missingDrCount, 1);
  assert.equal(agg.knownUniqueDomains, 2);
  assert.equal(agg.minDr, 20);
  assert.equal(agg.maxDr, 30);
  assert.equal(agg.medianDr, 25); // median of [20, 30]
  assert.equal(agg.uniqueDomains, 3);
});

test('repeated domains count once with the first-position representative DR', () => {
  const rows = [
    serp('k', 1, 'a.com', 10, 'ok'),
    serp('k', 2, 'a.com', 99, 'ok'), // same domain, different DR -> first position wins
    serp('k', 3, 'b.com', 80, 'ok'),
  ];
  const agg = aggregate({ keyword: 'k', normalizedKeyword: 'k', surfer: null, serpRows: rows }, THRESHOLDS);
  assert.equal(agg.uniqueDomains, 2);
  assert.equal(agg.minDr, 10); // a.com representative is position 1 (dr 10)
  assert.equal(agg.maxDr, 80);
  assert.equal(agg.medianDr, 45); // (10 + 80) / 2
});

test('top3 and top5 medians use actual rows in positions 1-3 / 1-5 with known DR', () => {
  const rows = [1, 2, 3, 4, 5, 6].map((pos) => serp('k', pos, `d${pos}.com`, pos * 10, 'ok'));
  const agg = aggregate({ keyword: 'k', normalizedKeyword: 'k', surfer: null, serpRows: rows }, THRESHOLDS);
  assert.equal(agg.top3MedianDr, 20); // median([10, 20, 30])
  assert.equal(agg.top5MedianDr, 30); // median([10, 20, 30, 40, 50])
});

test('exact-match counts a domain whose label (suffix stripped) equals the keyword label', () => {
  const rows = [
    serp('example', 1, 'example.com', 50, 'ok'), // "example" (suffix stripped) == keyword label
    serp('example', 2, 'other.com', 50, 'ok'),
  ];
  const agg = aggregate({ keyword: 'example', normalizedKeyword: 'example', surfer: null, serpRows: rows }, THRESHOLDS);
  assert.equal(agg.exactMatchDomainCount, 1);
});

test('niche-domain heuristic counts non-exact domains containing a >=4-char keyword token', () => {
  const rows = [
    serp('compare lists', 1, 'comparetools.com', 50, 'ok'), // not exact, but "compare" token present
    serp('compare lists', 2, 'unrelated.com', 50, 'ok'),
  ];
  const agg = aggregate(
    { keyword: 'compare lists', normalizedKeyword: 'comparelists', surfer: null, serpRows: rows },
    THRESHOLDS,
  );
  assert.equal(agg.exactMatchDomainCount, 0);
  assert.equal(agg.nicheDomainCount, 1);
});

test('serp diversity is unique domains over organic count and zero without results', () => {
  const rows = [
    serp('k', 1, 'a.com', 10, 'ok'),
    serp('k', 2, 'b.com', 20, 'ok'),
    serp('k', 3, 'a.com', 10, 'ok'),
  ];
  const agg = aggregate({ keyword: 'k', normalizedKeyword: 'k', surfer: null, serpRows: rows }, THRESHOLDS);
  assert.equal(agg.uniqueDomains, 2);
  assert.equal(agg.organicResultCount, 3);
  assert.equal(agg.serpDiversity, 2 / 3);
  assert.equal(aggregate({ keyword: 'k', normalizedKeyword: 'k', surfer: null, serpRows: [] }, THRESHOLDS).serpDiversity, 0);
});

test('DR thresholds classify unique domains into the correct bands', () => {
  const rows = [
    serp('k', 1, 'a.com', 5, 'ok'), // very weak
    serp('k', 2, 'b.com', 20, 'ok'), // weak
    serp('k', 3, 'c.com', 50, 'ok'), // neutral
    serp('k', 4, 'd.com', 65, 'ok'), // strong
    serp('k', 5, 'e.com', 90, 'ok'), // very strong
  ];
  const agg = aggregate({ keyword: 'k', normalizedKeyword: 'k', surfer: null, serpRows: rows }, THRESHOLDS);
  assert.equal(agg.veryWeakDomainsCount, 1);
  assert.equal(agg.weakDomainsCount, 1);
  assert.equal(agg.strongDomainsCount, 1);
  assert.equal(agg.veryStrongDomainsCount, 1);
});

test('failed / non-terminal keywords are unscored', () => {
  const features = aggregate({ keyword: 'k', normalizedKeyword: 'k', surfer: null, serpRows: [] }, THRESHOLDS);
  const failed = score(features, 'failed', null, null);
  assert.equal(failed.score, null);
  assert.equal(failed.tier, null);
  assert.equal(failed.rationale, '');
  const running = score(features, 'running', 100, 1);
  assert.equal(running.score, null);
});

test('no-data completed keyword scores 0 and is tier D', () => {
  const features = aggregate({ keyword: 'k', normalizedKeyword: 'k', surfer: null, serpRows: [] }, THRESHOLDS);
  const result = score(features, 'completed', null, null);
  assert.equal(result.score, 0);
  assert.equal(result.tier, 'D');
});

test('maximum-signal keyword scores exactly 85 and is tier A', () => {
  const features = {
    organicResultCount: 10,
    uniqueDomains: 10,
    knownUniqueDomains: 10,
    minDr: 0,
    maxDr: 0,
    medianDr: 0,
    top3MedianDr: 0,
    top5MedianDr: 0,
    veryWeakDomainsCount: 0,
    weakDomainsCount: 0,
    strongDomainsCount: 0,
    veryStrongDomainsCount: 0,
    missingDrCount: 0,
    exactMatchDomainCount: 0,
    nicheDomainCount: 0,
    serpDiversity: 1,
  };
  const result = score(features, 'completed', 100000, 20);
  assert.equal(result.score, 85);
  assert.equal(result.tier, 'A');
});

test('mid-signal keyword scores exactly 72.5 and is tier B', () => {
  const features = {
    organicResultCount: 10,
    uniqueDomains: 10,
    knownUniqueDomains: 10,
    minDr: 40,
    maxDr: 40,
    medianDr: 40,
    top3MedianDr: 40,
    top5MedianDr: 40,
    veryWeakDomainsCount: 0,
    weakDomainsCount: 0,
    strongDomainsCount: 0,
    veryStrongDomainsCount: 0,
    missingDrCount: 0,
    exactMatchDomainCount: 0,
    nicheDomainCount: 0,
    serpDiversity: 1,
  };
  const result = score(features, 'completed', 100000, 20);
  assert.equal(result.score, 72.5);
  assert.equal(result.tier, 'B');
});

test('missing DR never inflates accessibility (no fake zero)', () => {
  // All domains missing DR -> median/top3 are null -> 0 contribution, not a
  // spurious strong score from a zero.
  const rows = [
    serp('k', 1, 'a.com', null, 'error'),
    serp('k', 2, 'b.com', null, 'not_found'),
  ];
  const agg = aggregate({ keyword: 'k', normalizedKeyword: 'k', surfer: null, serpRows: rows }, THRESHOLDS);
  const result = score(agg, 'completed', 100000, 20);
  // demand 30 + commercial 10 + diversity (2/2=1 ->10) + completeness (0 known ->0 +2 +2=4) = 54
  assert.equal(result.score, 54);
  assert.equal(result.tier, 'C');
});

test('buildCandidates sorts by score desc, volume desc, normalized keyword asc, nulls last', () => {
  const keywords = [
    { keyword: 'aaa', normalizedKeyword: 'aaa', status: 'completed' as KeywordStatus, error: null, surfer: { volume: 100, cpc: 1 } },
    { keyword: 'bbb', normalizedKeyword: 'bbb', status: 'completed' as KeywordStatus, error: null, surfer: { volume: 100, cpc: 1 } },
    { keyword: 'ccc', normalizedKeyword: 'ccc', status: 'failed' as KeywordStatus, error: { code: 'X', message: 'm' }, surfer: null },
    { keyword: 'ddd', normalizedKeyword: 'ddd', status: 'completed' as KeywordStatus, error: null, surfer: { volume: 500, cpc: 1 } },
  ];
  const serpRows: SerpResult[] = [
    serp('aaa', 1, 'a.com', 10, 'ok'),
    serp('bbb', 1, 'b.com', 10, 'ok'),
    serp('ddd', 1, 'd.com', 10, 'ok'),
    // ccc has no serp rows
  ];
  const candidates = buildCandidates(keywords, serpRows, THRESHOLDS);
  assert.equal(candidates.length, 4);
  // ddd (volume 500) first, then aaa/bbb (volume 100) ordered by normalized asc, then ccc (null score) last.
  assert.equal(candidates[0]!.keyword, 'ddd');
  assert.equal(candidates[1]!.keyword, 'aaa');
  assert.equal(candidates[2]!.keyword, 'bbb');
  assert.equal(candidates[3]!.keyword, 'ccc');
  assert.equal(candidates[3]!.score, null);
  assert.equal(candidates[0]!.scoringVersion, SCORING_VERSION);
});

test('SCORING_VERSION is the documented contract version', () => {
  assert.equal(SCORING_VERSION, '1.0.0');
});
