import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCandidatesCsv } from './snapshots.js';
import { SCORING_VERSION, type Candidate } from '../scoring/scoring.js';

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    keyword: 'broken serp',
    normalizedKeyword: 'broken serp',
    status: 'partial',
    errorCode: 'GOOGLE_SERP_PARSE_ERROR',
    errorMessage: 'selector failed',
    serpStatus: 'parse_error',
    serpErrorCode: 'GOOGLE_SERP_PARSE_ERROR',
    serpErrorMessage: 'selector failed',
    organicResultCount: null,
    uniqueDomains: null,
    knownUniqueDomains: null,
    minDr: null,
    maxDr: null,
    medianDr: null,
    top3MedianDr: null,
    top5MedianDr: null,
    veryWeakDomainsCount: null,
    weakDomainsCount: null,
    strongDomainsCount: null,
    veryStrongDomainsCount: null,
    missingDrCount: null,
    exactMatchDomainCount: null,
    nicheDomainCount: null,
    serpDiversity: null,
    surferVolume: 1000,
    surferCpc: 2,
    score: null,
    tier: null,
    scoringVersion: SCORING_VERSION,
    scoringCompleteness: 'degraded',
    rationale: '',
    ...overrides,
  };
}

test('candidates.csv serializes unavailable SERP-derived numerics as blank cells', () => {
  const csv = renderCandidatesCsv([candidate()]);
  const lines = csv.slice(1).split('\r\n').filter(Boolean);

  assert.equal(
    lines[1],
    `broken serp,broken serp,partial,GOOGLE_SERP_PARSE_ERROR,selector failed,,,,,,,,,,,,,,,,,1000,2,,,${SCORING_VERSION},degraded,`,
  );
  assert.ok(!csv.includes('null'));
});

test('candidates.csv preserves real zero values for a genuine empty SERP', () => {
  const csv = renderCandidatesCsv([
    candidate({
      keyword: 'real empty',
      normalizedKeyword: 'real empty',
      status: 'completed',
      errorCode: null,
      errorMessage: null,
      serpStatus: 'empty',
      serpErrorCode: null,
      serpErrorMessage: null,
      organicResultCount: 0,
      uniqueDomains: 0,
      knownUniqueDomains: 0,
      veryWeakDomainsCount: 0,
      weakDomainsCount: 0,
      strongDomainsCount: 0,
      veryStrongDomainsCount: 0,
      missingDrCount: 0,
      exactMatchDomainCount: 0,
      nicheDomainCount: 0,
      serpDiversity: 0,
      score: 12.5,
      tier: 'D',
      scoringCompleteness: 'degraded',
      rationale: 'observed empty',
    }),
  ]);
  const lines = csv.slice(1).split('\r\n').filter(Boolean);

  assert.ok(lines[1]?.includes(`,0,0,0,,,,,,0,0,0,0,0,0,0,0,1000,2,12.5,D,${SCORING_VERSION},degraded,observed empty`));
});
