import { normalizeKeyword } from '../input/seeds/normalize.js';
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

export type ExpansionReplayVariant = {
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
  postHocObservedOnly: {
    durableChildCount: number;
    durableChildCoveragePercent: number | null;
    counterfactualUnknownCount: number;
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

export type ExpansionReplayResult = {
  version: typeof EXPANSION_REPLAY_VERSION;
  runId: string;
  admissionVersion: typeof EXPANSION_ADMISSION_VERSION;
  originalKeywordCount: number;
  rawCandidateCount: number;
  eligibleCandidateCount: number;
  budget: number;
  variants: ExpansionReplayVariant[];
  methodology: {
    selectorEvidence: 'pre_serp_related_only';
    evaluatorEvidence: 'durably_collected_child_evidence_only';
    missingCounterfactuals: 'unknown_not_zero';
    automaticWinner: 'not_computed';
  };
};

export type BuildExpansionReplayInput = {
  runId: string;
  originalKeywords: ReadonlyArray<string>;
  related: ReadonlyArray<ExpansionRelatedOccurrence>;
  maxCandidatesPerKeyword: number;
  minOverlap: number;
  minVolume: number;
  candidateEvidence: ReadonlyArray<Candidate>;
};

const VARIANT_DESCRIPTIONS: Record<ExpansionReplayVariantId, string> = {
  v1: 'Production V1: broadening → support → overlap → specificity → volume.',
  broadening_after_support: 'support → broadening → overlap → specificity → volume.',
  broadening_after_overlap: 'support → overlap → broadening → specificity → volume.',
  broadening_last: 'support → overlap → specificity → volume → broadening.',
};

export function buildExpansionReplay(input: BuildExpansionReplayInput): ExpansionReplayResult {
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
  const evidenceByKeyword = new Map(
    input.candidateEvidence.map((candidate) => [candidate.normalizedKeyword, candidate] as const),
  );

  const variants = EXPANSION_REPLAY_VARIANTS.map((id): ExpansionReplayVariant => {
    const selected = id === 'v1'
      ? baselineSelected
      : [...eligible].sort((a, b) => compareVariant(id, a, b)).slice(0, admission.budget);
    return buildVariant(id, selected, baselineSet, evidenceByKeyword);
  });

  return {
    version: EXPANSION_REPLAY_VERSION,
    runId: input.runId,
    admissionVersion: admission.version,
    originalKeywordCount: admission.originalKeywordCount,
    rawCandidateCount: admission.rawCandidateCount,
    eligibleCandidateCount: admission.eligibleCandidateCount,
    budget: admission.budget,
    variants,
    methodology: {
      selectorEvidence: 'pre_serp_related_only',
      evaluatorEvidence: 'durably_collected_child_evidence_only',
      missingCounterfactuals: 'unknown_not_zero',
      automaticWinner: 'not_computed',
    },
  };
}

function buildVariant(
  id: ExpansionReplayVariantId,
  selected: ReadonlyArray<ExpansionAdmissionDecision>,
  baselineSet: ReadonlySet<string>,
  evidenceByKeyword: ReadonlyMap<string, Candidate>,
): ExpansionReplayVariant {
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

  const evidence = selected
    .map((decision) => evidenceByKeyword.get(decision.normalizedKeyword) ?? null)
    .filter((candidate): candidate is Candidate => candidate !== null);
  const trustworthy = evidence.filter((candidate) => candidate.organicResultCount !== null);
  const scored = evidence.filter((candidate) => candidate.score !== null);
  const completeScoring = evidence.filter((candidate) => candidate.scoringCompleteness === 'complete');
  const childVolumes = evidence
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
    postHocObservedOnly: {
      durableChildCount: evidence.length,
      durableChildCoveragePercent: percent(evidence.length, selectedKeywords.length),
      counterfactualUnknownCount: selectedKeywords.length - evidence.length,
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
    },
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

export function expansionReplayChildKeywords<T extends { normalizedKeyword: string; sources: ReadonlyArray<{ type: string }> }>(
  keywords: ReadonlyArray<T>,
): T[] {
  return keywords.filter((keyword) => keyword.sources.some((source) => source.type === 'surfer_related'));
}

export function normalizeReplayKeyword(value: string): string {
  return normalizeKeyword(value);
}
