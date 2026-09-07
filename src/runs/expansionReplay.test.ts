import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../scoring/scoring.js';
import { buildExpansionAdmission } from './expansionAdmission.js';
import {
  buildExpansionReplaySelections,
  evaluateExpansionReplay,
  type BuildExpansionReplaySelectionsInput,
} from './expansionReplay.js';

const ORIGINALS = ['roof pitch calculator', 'roof slope calculator'];
const RELATED: BuildExpansionReplaySelectionsInput['related'] = [
  {
    parentIdx: 0,
    parentKeyword: ORIGINALS[0]!,
    relatedKeyword: 'roof calculator',
    overlap: 90,
    volume: 100_000,
    status: 'ok',
  },
  {
    parentIdx: 1,
    parentKeyword: ORIGINALS[1]!,
    relatedKeyword: 'roof calculator',
    overlap: 88,
    volume: 100_000,
    status: 'ok',
  },
  {
    parentIdx: 0,
    parentKeyword: ORIGINALS[0]!,
    relatedKeyword: 'roof pitch angle',
    overlap: 80,
    volume: 10_000,
    status: 'ok',
  },
  {
    parentIdx: 0,
    parentKeyword: ORIGINALS[0]!,
    relatedKeyword: 'roof pitch degrees',
    overlap: 70,
    volume: 9_000,
    status: 'ok',
  },
  {
    parentIdx: 1,
    parentKeyword: ORIGINALS[1]!,
    relatedKeyword: 'roof slope angle',
    overlap: 75,
    volume: 8_000,
    status: 'ok',
  },
];

function evidence(normalizedKeyword: string, score = 60, volume = 1_000): Candidate {
  return {
    keyword: normalizedKeyword,
    normalizedKeyword,
    status: 'completed',
    errorCode: null,
    errorMessage: null,
    serpStatus: 'ok',
    serpErrorCode: null,
    serpErrorMessage: null,
    organicResultCount: 10,
    uniqueDomains: 10,
    knownUniqueDomains: 10,
    minDr: 5,
    maxDr: 80,
    medianDr: 35,
    top3MedianDr: 25,
    top5MedianDr: 30,
    veryWeakDomainsCount: 1,
    weakDomainsCount: 2,
    strongDomainsCount: 2,
    veryStrongDomainsCount: 1,
    missingDrCount: 0,
    exactMatchDomainCount: 0,
    nicheDomainCount: 1,
    serpDiversity: 1,
    surferVolume: volume,
    surferCpc: 1,
    score,
    tier: score >= 75 ? 'A' : score >= 55 ? 'B' : score >= 35 ? 'C' : 'D',
    scoringVersion: 'test',
    rationale: '',
    scoringCompleteness: 'complete',
  };
}

function materializedWithoutSerp(normalizedKeyword: string): Candidate {
  return {
    ...evidence(normalizedKeyword),
    status: 'failed',
    errorCode: 'GOOGLE_UNAVAILABLE',
    errorMessage: 'no trustworthy SERP',
    serpStatus: 'fetch_error',
    serpErrorCode: 'GOOGLE_UNAVAILABLE',
    serpErrorMessage: 'no trustworthy SERP',
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
    score: null,
    tier: null,
    scoringCompleteness: 'degraded',
  };
}

function input(): BuildExpansionReplaySelectionsInput {
  return {
    runId: 'replay-test',
    originalKeywords: ORIGINALS,
    related: RELATED,
    maxCandidatesPerKeyword: 20,
    minOverlap: 0,
    minVolume: 0,
  };
}

test('V1 replay selection exactly matches the production admission selection', () => {
  const production = buildExpansionAdmission({
    originalKeywords: ORIGINALS,
    related: RELATED,
    maxCandidatesPerKeyword: 20,
    minOverlap: 0,
    minVolume: 0,
  });
  const replay = buildExpansionReplaySelections(input());
  const baseline = replay.variants.find((variant) => variant.id === 'v1')!;

  assert.equal(replay.methodology.baseline, 'current_v1_policy_replay');
  assert.equal(replay.budget, 3);
  assert.deepEqual(
    [...baseline.selectedKeywords].sort(),
    production.decisions.filter((decision) => decision.selected).map((decision) => decision.normalizedKeyword).sort(),
  );
});

test('moving broadening behind parent support changes only ranking, not eligibility or budget', () => {
  const replay = buildExpansionReplaySelections(input());
  const baseline = replay.variants.find((variant) => variant.id === 'v1')!;
  const afterSupport = replay.variants.find((variant) => variant.id === 'broadening_after_support')!;

  assert.equal(replay.eligibleCandidateCount, 4);
  assert.equal(baseline.selectedCount, replay.budget);
  assert.equal(afterSupport.selectedCount, replay.budget);
  assert.equal(baseline.selectedKeywords.includes('roof calculator'), false);
  assert.equal(afterSupport.selectedKeywords.includes('roof calculator'), true);
  assert.equal(afterSupport.versusV1.addedCount, 1);
  assert.equal(afterSupport.versusV1.removedCount, 1);
});

test('selector API is fixed before any post-hoc child evidence is connected', () => {
  const selections = buildExpansionReplaySelections(input());
  const evaluated = evaluateExpansionReplay(selections, [
    evidence('roof calculator', 99, 9_000_000),
    evidence('roof pitch angle', 1, 1),
    evidence('roof pitch degrees', 1, 1),
    evidence('roof slope angle', 1, 1),
  ]);

  assert.deepEqual(
    evaluated.variants.map((variant) => [variant.id, variant.selectedKeywords]),
    selections.variants.map((variant) => [variant.id, variant.selectedKeywords]),
  );
});

test('unmaterialized counterfactual children remain unknown instead of becoming zero-quality evidence', () => {
  const selections = buildExpansionReplaySelections(input());
  const replay = evaluateExpansionReplay(selections, [
    evidence('roof pitch angle'),
    evidence('roof pitch degrees'),
    evidence('roof slope angle'),
  ]);
  const baseline = replay.variants.find((variant) => variant.id === 'v1')!;
  const afterSupport = replay.variants.find((variant) => variant.id === 'broadening_after_support')!;

  assert.equal(baseline.postHocObservedOnly.durableChildKeywordCount, 3);
  assert.equal(baseline.postHocObservedOnly.counterfactualUnmaterializedCount, 0);
  assert.equal(afterSupport.postHocObservedOnly.durableChildKeywordCount, 2);
  assert.equal(afterSupport.postHocObservedOnly.counterfactualUnmaterializedCount, 1);
  assert.equal(afterSupport.postHocObservedOnly.durableChildKeywordCoveragePercent, 66.67);
  assert.equal(afterSupport.postHocObservedOnly.trustworthySerpCount, 2);
});

test('materialized child presence is distinct from trustworthy SERP observation', () => {
  const selections = buildExpansionReplaySelections(input());
  const replay = evaluateExpansionReplay(selections, [
    materializedWithoutSerp('roof pitch angle'),
    evidence('roof pitch degrees'),
    evidence('roof slope angle'),
  ]);
  const baseline = replay.variants.find((variant) => variant.id === 'v1')!;

  assert.equal(baseline.postHocObservedOnly.durableChildKeywordCount, 3);
  assert.equal(baseline.postHocObservedOnly.durableChildKeywordCoveragePercent, 100);
  assert.equal(baseline.postHocObservedOnly.trustworthySerpCount, 2);
  assert.equal(baseline.postHocObservedOnly.trustworthySerpCoveragePercent, 66.67);
  assert.equal(baseline.postHocObservedOnly.scoredChildCount, 2);
});

test('related root completeness is explicit and missing roots are not treated as empty', () => {
  const replay = buildExpansionReplaySelections({
    ...input(),
    originalKeywords: [...ORIGINALS, 'third root calculator'],
  });

  assert.deepEqual(replay.relatedEvidence, {
    denominator: 3,
    ok: 2,
    empty: 0,
    error: 0,
    notAttempted: 1,
  });
});
