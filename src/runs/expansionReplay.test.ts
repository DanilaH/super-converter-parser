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

test('uncollected counterfactual children remain unknown instead of becoming zero-quality evidence', () => {
  const selections = buildExpansionReplaySelections(input());
  const replay = evaluateExpansionReplay(selections, [
    evidence('roof pitch angle'),
    evidence('roof pitch degrees'),
    evidence('roof slope angle'),
  ]);
  const baseline = replay.variants.find((variant) => variant.id === 'v1')!;
  const afterSupport = replay.variants.find((variant) => variant.id === 'broadening_after_support')!;

  assert.equal(baseline.postHocObservedOnly.durableChildCount, 3);
  assert.equal(baseline.postHocObservedOnly.counterfactualUnknownCount, 0);
  assert.equal(afterSupport.postHocObservedOnly.durableChildCount, 2);
  assert.equal(afterSupport.postHocObservedOnly.counterfactualUnknownCount, 1);
  assert.equal(afterSupport.postHocObservedOnly.durableChildCoveragePercent, 66.67);
  assert.equal(afterSupport.postHocObservedOnly.trustworthySerpCount, 2);
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
