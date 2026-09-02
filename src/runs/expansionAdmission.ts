import { normalizeKeyword } from '../input/seeds/normalize.js';

export const EXPANSION_ADMISSION_VERSION = 'v1' as const;

export const EXPANSION_ADMISSION_POLICY_V1 = {
  minCandidateTokens: 2,
  maxAddedRatio: 1.25,
  maxAddedBudget: 500,
  strongParentSupport: 2,
  highParentSupport: 3,
} as const;

export type ExpansionAdmissionReason =
  | 'selected'
  | 'existing_keyword'
  | 'single_token'
  | 'below_min_signal'
  | 'parent_cap'
  | 'global_budget';

export type ExpansionRelatedOccurrence = {
  parentIdx: number;
  parentKeyword: string;
  relatedKeyword: string;
  overlap: number | null;
  volume: number | null;
  status: 'ok' | 'empty' | 'error';
};

export type ExpansionAdmissionDecision = {
  keyword: string;
  normalizedKeyword: string;
  tokenCount: number;
  parentSupport: number;
  parentSupportTier: 0 | 1 | 2;
  bestOverlap: number | null;
  maxVolume: number | null;
  broadeningOnly: boolean;
  supportingParents: string[];
  selected: boolean;
  reason: ExpansionAdmissionReason;
};

export type ExpansionAdmissionResult = {
  version: typeof EXPANSION_ADMISSION_VERSION;
  policy: typeof EXPANSION_ADMISSION_POLICY_V1;
  originalKeywordCount: number;
  rawCandidateCount: number;
  eligibleCandidateCount: number;
  budget: number;
  selectedCount: number;
  decisions: ExpansionAdmissionDecision[];
};

type CandidateOccurrence = ExpansionRelatedOccurrence & {
  normalizedKeyword: string;
  normalizedParent: string;
  tokenCount: number;
};

type RankedCandidate = {
  keyword: string;
  normalizedKeyword: string;
  tokenCount: number;
  parentSupport: number;
  parentSupportTier: 0 | 1 | 2;
  bestOverlap: number | null;
  maxVolume: number | null;
  broadeningOnly: boolean;
  supportingParents: string[];
};

export function expansionAddedBudget(originalKeywordCount: number): number {
  if (!Number.isInteger(originalKeywordCount) || originalKeywordCount < 0) {
    throw new Error(`originalKeywordCount must be a non-negative integer, got ${originalKeywordCount}`);
  }
  return Math.min(
    EXPANSION_ADMISSION_POLICY_V1.maxAddedBudget,
    Math.ceil(originalKeywordCount * EXPANSION_ADMISSION_POLICY_V1.maxAddedRatio),
  );
}

export function buildExpansionAdmission(input: {
  originalKeywords: ReadonlyArray<string>;
  related: ReadonlyArray<ExpansionRelatedOccurrence>;
  maxCandidatesPerKeyword: number;
  minOverlap: number;
  minVolume: number;
}): ExpansionAdmissionResult {
  if (!Number.isInteger(input.maxCandidatesPerKeyword) || input.maxCandidatesPerKeyword < 1) {
    throw new Error(`maxCandidatesPerKeyword must be a positive integer, got ${input.maxCandidatesPerKeyword}`);
  }
  if (!Number.isFinite(input.minOverlap) || input.minOverlap < 0) {
    throw new Error(`minOverlap must be a non-negative number, got ${input.minOverlap}`);
  }
  if (!Number.isFinite(input.minVolume) || input.minVolume < 0) {
    throw new Error(`minVolume must be a non-negative number, got ${input.minVolume}`);
  }

  const originals = new Set(input.originalKeywords.map(normalizeKeyword));
  const rawByCandidate = groupRawCandidates(input.related);
  const thresholdPassing = input.related
    .filter((row) => row.status === 'ok')
    .map(toCandidateOccurrence)
    .filter((row) => passesMinimumSignal(row, input.minOverlap, input.minVolume));
  const admittedPerParent = applyPerParentCap(thresholdPassing, input.maxCandidatesPerKeyword);
  const eligibleByCandidate = groupOccurrences(admittedPerParent);
  const thresholdByCandidate = groupOccurrences(thresholdPassing);
  const ranked: RankedCandidate[] = [];
  const fixedDecisions: ExpansionAdmissionDecision[] = [];

  for (const [normalizedKeyword, rawRows] of rawByCandidate) {
    const rawOccurrences = rawRows.map(toCandidateOccurrence);
    const rawCandidate = rankCandidate(rawOccurrences);
    if (originals.has(normalizedKeyword)) {
      fixedDecisions.push(rejected(rawCandidate, 'existing_keyword'));
      continue;
    }
    if (rawCandidate.tokenCount < EXPANSION_ADMISSION_POLICY_V1.minCandidateTokens) {
      fixedDecisions.push(rejected(rawCandidate, 'single_token'));
      continue;
    }
    const thresholdRows = thresholdByCandidate.get(normalizedKeyword) ?? [];
    if (thresholdRows.length === 0) {
      fixedDecisions.push(rejected(rawCandidate, 'below_min_signal'));
      continue;
    }
    const thresholdCandidate = rankCandidate(thresholdRows);
    const eligibleRows = eligibleByCandidate.get(normalizedKeyword) ?? [];
    if (eligibleRows.length === 0) {
      fixedDecisions.push(rejected(thresholdCandidate, 'parent_cap'));
      continue;
    }
    ranked.push(rankCandidate(eligibleRows));
  }

  ranked.sort(compareRankedCandidates);
  const budget = expansionAddedBudget(originals.size);
  const selected = new Set(ranked.slice(0, budget).map((candidate) => candidate.normalizedKeyword));
  const rankedDecisions = ranked.map((candidate): ExpansionAdmissionDecision => ({
    ...candidate,
    selected: selected.has(candidate.normalizedKeyword),
    reason: selected.has(candidate.normalizedKeyword) ? 'selected' : 'global_budget',
  }));
  const decisions = [...rankedDecisions, ...fixedDecisions].sort((a, b) =>
    Number(b.selected) - Number(a.selected)
      || compareDecisionPriority(a, b)
      || a.normalizedKeyword.localeCompare(b.normalizedKeyword),
  );

  return {
    version: EXPANSION_ADMISSION_VERSION,
    policy: EXPANSION_ADMISSION_POLICY_V1,
    originalKeywordCount: originals.size,
    rawCandidateCount: rawByCandidate.size,
    eligibleCandidateCount: ranked.length,
    budget,
    selectedCount: selected.size,
    decisions,
  };
}

function groupRawCandidates(rows: ReadonlyArray<ExpansionRelatedOccurrence>): Map<string, ExpansionRelatedOccurrence[]> {
  const grouped = new Map<string, ExpansionRelatedOccurrence[]>();
  for (const row of rows) {
    if (row.status !== 'ok') continue;
    const normalized = normalizeKeyword(row.relatedKeyword);
    if (normalized === '') continue;
    const existing = grouped.get(normalized) ?? [];
    existing.push(row);
    grouped.set(normalized, existing);
  }
  return grouped;
}

function groupOccurrences(rows: ReadonlyArray<CandidateOccurrence>): Map<string, CandidateOccurrence[]> {
  const grouped = new Map<string, CandidateOccurrence[]>();
  for (const row of rows) {
    const existing = grouped.get(row.normalizedKeyword) ?? [];
    existing.push(row);
    grouped.set(row.normalizedKeyword, existing);
  }
  return grouped;
}

function applyPerParentCap(
  rows: ReadonlyArray<CandidateOccurrence>,
  maxCandidatesPerKeyword: number,
): CandidateOccurrence[] {
  const byParent = new Map<number, CandidateOccurrence[]>();
  for (const row of rows) {
    const existing = byParent.get(row.parentIdx) ?? [];
    existing.push(row);
    byParent.set(row.parentIdx, existing);
  }

  const selected: CandidateOccurrence[] = [];
  for (const parentRows of byParent.values()) {
    const bestByCandidate = new Map<string, CandidateOccurrence>();
    for (const row of parentRows) {
      const previous = bestByCandidate.get(row.normalizedKeyword);
      if (previous === undefined || compareOccurrences(row, previous) < 0) {
        bestByCandidate.set(row.normalizedKeyword, row);
      }
    }
    selected.push(
      ...[...bestByCandidate.values()]
        .sort(compareOccurrences)
        .slice(0, maxCandidatesPerKeyword),
    );
  }
  return selected;
}

function rankCandidate(rows: CandidateOccurrence[]): RankedCandidate {
  const representative = bestOccurrence(rows);
  const supportingParents = [...new Map(rows.map((row) => [row.parentIdx, row.normalizedParent])).values()].sort();
  const tokenCount = keywordTokens(representative.normalizedKeyword).length;
  const parentSupport = new Set(rows.map((row) => row.parentIdx)).size;
  const candidateTokenSet = new Set(keywordTokens(representative.normalizedKeyword));
  const parentTokenSets = [...new Map(rows.map((row) => [row.parentIdx, new Set(keywordTokens(row.normalizedParent))])).values()];
  const broadeningOnly = parentTokenSets.length > 0
    && parentTokenSets.every((parentTokens) => isStrictSubset(candidateTokenSet, parentTokens));

  return {
    keyword: representative.relatedKeyword,
    normalizedKeyword: representative.normalizedKeyword,
    tokenCount,
    parentSupport,
    parentSupportTier: parentSupport >= EXPANSION_ADMISSION_POLICY_V1.highParentSupport
      ? 2
      : parentSupport >= EXPANSION_ADMISSION_POLICY_V1.strongParentSupport
        ? 1
        : 0,
    bestOverlap: maxNullable(rows.map((row) => row.overlap)),
    maxVolume: maxNullable(rows.map((row) => row.volume)),
    broadeningOnly,
    supportingParents,
  };
}

function compareRankedCandidates(a: RankedCandidate, b: RankedCandidate): number {
  return Number(a.broadeningOnly) - Number(b.broadeningOnly)
    || b.parentSupportTier - a.parentSupportTier
    || compareNullableDesc(a.bestOverlap, b.bestOverlap)
    || Math.min(b.tokenCount, 4) - Math.min(a.tokenCount, 4)
    || compareNullableDesc(a.maxVolume, b.maxVolume)
    || a.normalizedKeyword.localeCompare(b.normalizedKeyword);
}

function compareDecisionPriority(a: ExpansionAdmissionDecision, b: ExpansionAdmissionDecision): number {
  return Number(a.broadeningOnly) - Number(b.broadeningOnly)
    || b.parentSupportTier - a.parentSupportTier
    || compareNullableDesc(a.bestOverlap, b.bestOverlap)
    || Math.min(b.tokenCount, 4) - Math.min(a.tokenCount, 4)
    || compareNullableDesc(a.maxVolume, b.maxVolume);
}

function compareOccurrences(a: CandidateOccurrence, b: CandidateOccurrence): number {
  return compareNullableDesc(a.overlap, b.overlap)
    || compareNullableDesc(a.volume, b.volume)
    || Math.min(b.tokenCount, 4) - Math.min(a.tokenCount, 4)
    || a.normalizedKeyword.localeCompare(b.normalizedKeyword);
}

function bestOccurrence(rows: CandidateOccurrence[]): CandidateOccurrence {
  if (rows.length === 0) throw new Error('Expansion candidate has no occurrences.');
  return [...rows].sort(compareOccurrences)[0]!;
}

function toCandidateOccurrence(row: ExpansionRelatedOccurrence): CandidateOccurrence {
  const normalizedKeyword = normalizeKeyword(row.relatedKeyword);
  return {
    ...row,
    normalizedKeyword,
    normalizedParent: normalizeKeyword(row.parentKeyword),
    tokenCount: keywordTokens(normalizedKeyword).length,
  };
}

function passesMinimumSignal(row: CandidateOccurrence, minOverlap: number, minVolume: number): boolean {
  return (minOverlap === 0 || (row.overlap ?? 0) >= minOverlap)
    && (minVolume === 0 || (row.volume ?? 0) >= minVolume);
}

function rejected(
  candidate: RankedCandidate,
  reason: Exclude<ExpansionAdmissionReason, 'selected' | 'global_budget'>,
): ExpansionAdmissionDecision {
  return {
    ...candidate,
    selected: false,
    reason,
  };
}

function keywordTokens(keyword: string): string[] {
  return keyword.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isStrictSubset(candidate: ReadonlySet<string>, parent: ReadonlySet<string>): boolean {
  if (candidate.size >= parent.size) return false;
  for (const token of candidate) {
    if (!parent.has(token)) return false;
  }
  return true;
}

function maxNullable(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return known.length === 0 ? null : Math.max(...known);
}

function compareNullableDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}
