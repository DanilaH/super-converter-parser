import type { Candidate } from '../scoring/scoring.js';
import {
  buildExpansionAdmission,
  EXPANSION_ADMISSION_VERSION,
  type ExpansionAdmissionDecision,
  type ExpansionRelatedOccurrence,
} from './expansionAdmission.js';

export const EXPANSION_REPLAY_VERSION = '1.0.0' as const;

export const EXPANSION_REPLAY_VARIANTS = [
  'v1',
  'broadening_after_support',
  'broadening_after_overlap',
  'broadening_last',
] as const;

export type ExpansionReplayVariantId = typeof EXPANSION_REPLAY_VARIANTS[number];

export type ExpansionReplaySelectionVariant = {
  id: ExpansionReplayVariantId;
  description: string;
  selectedCount: number;
  selectedKeywords: string[];
  preSerp: {
    broadeningOnlyCount: number;
    broadeningOnlyPercent: number | null;
    parentSupportTierCounts: { tier0: number; tier1: number; tier2: number };
    medianBestOverlap: number | null;
    knownRelatedVolumeCount: number;
    medianMaxRelatedVolume: number | null;
    sumMaxRelatedVolume: number | null;
  };
  versusV1: {
    retainedCount: number;
    addedCount: number;
    removedCount: number;
    jaccard: number | null;
    addedKeywords: string[];
    removedKeywords: string[];
  };
};

export type ExpansionReplayVariant = ExpansionReplaySelectionVariant & {
  postHocEvidence: {
    durableChildKeywordCount: number;
    durableChildKeywordCoveragePercent: number | null;
    counterfactualUnmaterializedCount: number;
    trustworthySerpCount: number;
    trustworthySerpCoveragePercent: number | null;
    scoredChildCount: number;
    completeScoringCount: number;
    childVolumeKnownCount: number;
    medianChildVolume: number | null;
    sumChildVolume: number | null;
    medianCandidateScore: number | null;
    tierCounts: { A: number; B: number; C: number; D: number };
    weakSerpAtLeastOneCount: number;
    weakSerpAtLeastTwoCount: number;
  };
};

export type ExpansionReplaySelectionSet = {
  version: typeof EXPANSION_REPLAY_VERSION;
  runId: string;
  admissionVersion: typeof EXPANSION_ADMISSION_VERSION;
  originalKeywordCount: number;
  rawCandidateCount: number;
  eligibleCandidateCount: number;
  budget: number;
  relatedEvidence: {
    denominator: number;
    ok: number;
    empty: number;
    error: number;
    notAttempted: number;
  };
  variants: ExpansionReplaySelectionVariant[];
  methodology: {
    baseline: 'current_v1_policy_replay';
    selectorEvidence: 'pre_serp_related_only';
  };
};

export type ExpansionReplayResult = Omit<ExpansionReplaySelectionSet, 'variants' | 'methodology'> & {
  variants: ExpansionReplayVariant[];
  methodology: {
    baseline: 'current_v1_policy_replay';
    selectorEvidence: 'pre_serp_related_only';
    evaluatorEvidence: 'materialized_child_keywords_then_observed_evidence';
    missingCounterfactuals: 'unmaterialized_or_unobserved_stay_unknown';
    automaticWinner: 'not_computed';
  };
};

export type BuildExpansionReplaySelectionsInput = {
  runId: string;
  originalKeywords: ReadonlyArray<string>;
  related: ReadonlyArray<ExpansionRelatedOccurrence>;
  maxCandidatesPerKeyword: number;
  minOverlap: number;
  minVolume: number;
};

const VARIANT_DESCRIPTIONS: Record<ExpansionReplayVariantId, string> = {
  v1: 'Current V1 policy replay: broadening → support → overlap → specificity → volume.',
  broadening_after_support: 'support → broadening → overlap → specificity → volume.',
  broadening_after_overlap: 'support → overlap → broadening → specificity → volume.',
  broadening_last: 'support → overlap → specificity → volume → broadening.',
};

export function buildExpansionReplaySelections(
  input: BuildExpansionReplaySelectionsInput,
): ExpansionReplaySelectionSet {
  const admission = buildExpansionAdmission({
    originalKeywords: input.originalKeywords,
    related: input.related,
    maxCandidatesPerKeyword: input.maxCandidatesPerKeyword,
    minOverlap: input.minOverlap,
    minVolume: input.minVolume,
  });
  const eligible = admission.decisions.filter(
    (decision) => decision.reason === 'selected' || decision.reason === 'global_budget',
  );
  const baselineSelected = admission.decisions.filter((decision) => decision.selected);
  const baselineSet = new Set(baselineSelected.map((decision) => decision.normalizedKeyword));

  const variants = EXPANSION_REPLAY_VARIANTS.map((id): ExpansionReplaySelectionVariant => {
    const selected = id === 'v1'
      ? baselineSelected
      : [...eligible].sort((a, b) => compareVariant(id, a, b)).slice(0, admission.budget);
    return buildSelectionVariant(id, selected, baselineSet);
  });

  return {
    version: EXPANSION_REPLAY_VERSION,
    runId: input.runId,
    admissionVersion: admission.version,
    originalKeywordCount: admission.originalKeywordCount,
    rawCandidateCount: admission.rawCandidateCount,
    eligibleCandidateCount: admission.eligibleCandidateCount,
    budget: admission.budget,
    relatedEvidence: summarizeRelatedEvidence(admission.originalKeywordCount, input.related),
    variants,
    methodology: {
      baseline: 'current_v1_policy_replay',
      selectorEvidence: 'pre_serp_related_only',
    },
  };
}

export function evaluateExpansionReplay(
  selections: ExpansionReplaySelectionSet,
  candidateEvidence: ReadonlyArray<Candidate>,
): ExpansionReplayResult {
  const evidenceByKeyword = new Map(
    candidateEvidence.map((candidate) => [candidate.normalizedKeyword, candidate] as const),
  );
  return {
    version: selections.version,
    runId: selections.runId,
    admissionVersion: selections.admissionVersion,
    originalKeywordCount: selections.originalKeywordCount,
    rawCandidateCount: selections.rawCandidateCount,
    eligibleCandidateCount: selections.eligibleCandidateCount,
    budget: selections.budget,
    relatedEvidence: selections.relatedEvidence,
    variants: selections.variants.map((variant) => ({
      ...variant,
      postHocEvidence: evaluateSelection(variant.selectedKeywords, evidenceByKeyword),
    })),
    methodology: {
      baseline: 'current_v1_policy_replay',
      selectorEvidence: 'pre_serp_related_only',
      evaluatorEvidence: 'materialized_child_keywords_then_observed_evidence',
      missingCounterfactuals: 'unmaterialized_or_unobserved_stay_unknown',
      automaticWinner: 'not_computed',
    },
  };
}

function buildSelectionVariant(
  id: ExpansionReplayVariantId,
  selected: ReadonlyArray<ExpansionAdmissionDecision>,
  baselineSet: ReadonlySet<string>,
): ExpansionReplaySelectionVariant {
  const selectedKeywords = selected.map((decision) => decision.normalizedKeyword);
  const selectedSet = new Set(selectedKeywords);
  const addedKeywords = selectedKeywords.filter((keyword) => !baselineSet.has(keyword)).sort();
  const removedKeywords = [...baselineSet].filter((keyword) => !selectedSet.has(keyword)).sort();
  const retainedCount = selectedKeywords.length - addedKeywords.length;
  const unionCount = new Set([...selectedKeywords, ...baselineSet]).size;
  const broadeningOnlyCount = selected.filter((decision) => decision.broadeningOnly).length;
  const overlaps = selected
    .map((decision) => decision.bestOverlap)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const relatedVolumes = selected
    .map((decision) => decision.maxVolume)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  return {
    id,
    description: VARIANT_DESCRIPTIONS[id],
    selectedCount: selectedKeywords.length,
    selectedKeywords,
    preSerp: {
      broadeningOnlyCount,
      broadeningOnlyPercent: percent(broadeningOnlyCount, selectedKeywords.length),
      parentSupportTierCounts: {
        tier0: selected.filter((decision) => decision.parentSupportTier === 0).length,
        tier1: selected.filter((decision) => decision.parentSupportTier === 1).length,
        tier2: selected.filter((decision) => decision.parentSupportTier === 2).length,
      },
      medianBestOverlap: median(overlaps),
      knownRelatedVolumeCount: relatedVolumes.length,
      medianMaxRelatedVolume: median(relatedVolumes),
      sumMaxRelatedVolume: sumKnown(relatedVolumes),
    },
    versusV1: {
      retainedCount,
      addedCount: addedKeywords.length,
      removedCount: removedKeywords.length,
      jaccard: unionCount === 0 ? null : retainedCount / unionCount,
      addedKeywords,
      removedKeywords,
    },
  };
}

function evaluateSelection(
  selectedKeywords: ReadonlyArray<string>,
  evidenceByKeyword: ReadonlyMap<string, Candidate>,
): ExpansionReplayVariant['postHocEvidence'] {
  const materialized = selectedKeywords
    .map((keyword) => evidenceByKeyword.get(keyword) ?? null)
    .filter((candidate): candidate is Candidate => candidate !== null);
  const trustworthy = materialized.filter((candidate) => candidate.organicResultCount !== null);
  const scored = materialized.filter((candidate) => candidate.score !== null);
  const completeScoring = materialized.filter((candidate) => candidate.scoringCompleteness === 'complete');
  const childVolumes = materialized
    .map((candidate) => candidate.surferVolume)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const scores = scored.map((candidate) => candidate.score as number);
  const tierCounts = { A: 0, B: 0, C: 0, D: 0 };
  for (const candidate of scored) {
    if (candidate.tier !== null) tierCounts[candidate.tier] += 1;
  }
  let weakSerpAtLeastOneCount = 0;
  let weakSerpAtLeastTwoCount = 0;
  for (const candidate of trustworthy) {
    const veryWeak = candidate.veryWeakDomainsCount;
    const weak = candidate.weakDomainsCount;
    if (veryWeak === null || weak === null) continue;
    const weakTotal = veryWeak + weak;
    if (weakTotal >= 1) weakSerpAtLeastOneCount += 1;
    if (weakTotal >= 2) weakSerpAtLeastTwoCount += 1;
  }

  return {
    durableChildKeywordCount: materialized.length,
    durableChildKeywordCoveragePercent: percent(materialized.length, selectedKeywords.length),
    counterfactualUnmaterializedCount: selectedKeywords.length - materialized.length,
    trustworthySerpCount: trustworthy.length,
    trustworthySerpCoveragePercent: percent(trustworthy.length, selectedKeywords.length),
    scoredChildCount: scored.length,
    completeScoringCount: completeScoring.length,
    childVolumeKnownCount: childVolumes.length,
    medianChildVolume: median(childVolumes),
    sumChildVolume: sumKnown(childVolumes),
    medianCandidateScore: median(scores),
    tierCounts,
    weakSerpAtLeastOneCount,
    weakSerpAtLeastTwoCount,
  };
}

function summarizeRelatedEvidence(
  originalKeywordCount: number,
  related: ReadonlyArray<ExpansionRelatedOccurrence>,
): ExpansionReplaySelectionSet['relatedEvidence'] {
  const outcomes = new Map<number, 'ok' | 'empty' | 'error'>();
  for (const row of related) {
    const current = outcomes.get(row.parentIdx);
    if (row.status === 'ok') outcomes.set(row.parentIdx, 'ok');
    else if (row.status === 'error' && current !== 'ok') outcomes.set(row.parentIdx, 'error');
    else if (row.status === 'empty' && current === undefined) outcomes.set(row.parentIdx, 'empty');
  }
  let ok = 0;
  let empty = 0;
  let error = 0;
  for (const outcome of outcomes.values()) {
    if (outcome === 'ok') ok += 1;
    else if (outcome === 'empty') empty += 1;
    else error += 1;
  }
  return {
    denominator: originalKeywordCount,
    ok,
    empty,
    error,
    notAttempted: Math.max(0, originalKeywordCount - outcomes.size),
  };
}

function compareVariant(
  id: Exclude<ExpansionReplayVariantId, 'v1'>,
  a: ExpansionAdmissionDecision,
  b: ExpansionAdmissionDecision,
): number {
  const support = (): number => b.parentSupportTier - a.parentSupportTier;
  const broadening = (): number => Number(a.broadeningOnly) - Number(b.broadeningOnly);
  const overlap = (): number => compareNullableDesc(a.bestOverlap, b.bestOverlap);
  const specificity = (): number => Math.min(b.tokenCount, 4) - Math.min(a.tokenCount, 4);
  const volume = (): number => compareNullableDesc(a.maxVolume, b.maxVolume);

  if (id === 'broadening_after_support') {
    return support() || broadening() || overlap() || specificity() || volume()
      || a.normalizedKeyword.localeCompare(b.normalizedKeyword);
  }
  if (id === 'broadening_after_overlap') {
    return support() || overlap() || broadening() || specificity() || volume()
      || a.normalizedKeyword.localeCompare(b.normalizedKeyword);
  }
  return support() || overlap() || specificity() || volume() || broadening()
    || a.normalizedKeyword.localeCompare(b.normalizedKeyword);
}

function percent(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function sumKnown(values: ReadonlyArray<number>): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function compareNullableDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

export function expansionReplayOriginalKeywords(
  keywords: ReadonlyArray<{ keyword: string; sources: ReadonlyArray<{ type: string }> }>,
): string[] {
  return keywords
    .filter((keyword) => !keyword.sources.some((source) => source.type === 'surfer_related'))
    .map((keyword) => keyword.keyword);
}

export function expansionReplayChildKeywords<T extends { sources: ReadonlyArray<{ type: string }> }>(
  keywords: ReadonlyArray<T>,
): T[] {
  return keywords.filter((keyword) => keyword.sources.some((source) => source.type === 'surfer_related'));
}
