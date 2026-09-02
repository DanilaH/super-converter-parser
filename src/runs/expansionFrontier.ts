import { join } from 'node:path';
import type { ResearchConfig } from '../config/config.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { RunStore, type StoredKeyword, type StoredRelatedKeyword } from '../db/store.js';
import { ResearchError } from '../shared/errors.js';
import { writeJsonAtomic, writeTextAtomic, type KeywordSource } from './run.js';
import {
  buildExpansionAdmission,
  type ExpansionAdmissionDecision,
  type ExpansionAdmissionResult,
  type ExpansionRelatedOccurrence,
} from './expansionAdmission.js';

export type ExpansionFrontierDecision = ExpansionAdmissionDecision & {
  selectedFinal: boolean;
  committedBefore: boolean;
};

export type ExpansionFrontierResult = {
  admission: ExpansionAdmissionResult;
  decisions: ExpansionFrontierDecision[];
  committedBeforeCount: number;
  addedKeywords: StoredKeyword[];
};

export async function materializeExpansionFrontier(input: {
  store: RunStore;
  runId: string;
  runDirectory: string;
  config: ResearchConfig;
}): Promise<ExpansionFrontierResult> {
  const keywords = input.store.loadKeywords(input.runId);
  const originals = keywords.filter((keyword) => !isExpansionKeyword(keyword));
  const committedKeywords = keywords.filter(isExpansionKeyword);
  const committed = new Set(committedKeywords.map((keyword) => keyword.normalizedKeyword));
  const related = input.store.loadRelatedKeywords(input.runId);
  const admission = buildExpansionAdmission({
    originalKeywords: originals.map((keyword) => keyword.keyword),
    related: related.map(toAdmissionOccurrence),
    maxCandidatesPerKeyword: input.config.expansion.maxCandidatesPerKeyword,
    minOverlap: input.config.expansion.minOverlap,
    minVolume: input.config.expansion.minVolume,
  });

  if (committed.size > admission.budget) {
    throw new ResearchError(
      'DB_ERROR',
      `Run ${input.runId} already contains ${committed.size} expansion keyword(s), exceeding the V1 admission budget ${admission.budget}. Refusing to silently rewrite the committed frontier.`,
    );
  }

  const finalSelected = new Set(committed);
  const rankedEligible = admission.decisions.filter(
    (decision) => decision.reason === 'selected' || decision.reason === 'global_budget',
  );
  for (const decision of rankedEligible) {
    if (finalSelected.size >= admission.budget) break;
    finalSelected.add(decision.normalizedKeyword);
  }

  const addedKeywords: StoredKeyword[] = [];
  const decisionByNormalized = new Map(
    admission.decisions.map((decision) => [decision.normalizedKeyword, decision] as const),
  );
  for (const normalizedKeyword of finalSelected) {
    if (committed.has(normalizedKeyword)) continue;
    const decision = decisionByNormalized.get(normalizedKeyword);
    if (!decision) {
      throw new ResearchError(
        'DB_ERROR',
        `Expansion admission selected ${normalizedKeyword} without a durable related-evidence decision.`,
      );
    }
    const sources = expansionSources(related, normalizedKeyword);
    if (sources.length === 0) {
      throw new ResearchError(
        'DB_ERROR',
        `Expansion admission selected ${normalizedKeyword} without a durable Surfer-related parent occurrence.`,
      );
    }
    addedKeywords.push(input.store.addKeyword(input.runId, {
      keyword: decision.keyword,
      normalizedKeyword,
      sources,
    }));
    committed.add(normalizedKeyword);
  }

  rewriteSelectedRelatedFlags(input.store, input.runId, related, finalSelected);

  const decisions: ExpansionFrontierDecision[] = admission.decisions.map((decision) => ({
    ...decision,
    selectedFinal: finalSelected.has(decision.normalizedKeyword),
    committedBefore: committedKeywords.some(
      (keyword) => keyword.normalizedKeyword === decision.normalizedKeyword,
    ),
  }));
  for (const keyword of committedKeywords) {
    if (decisionByNormalized.has(keyword.normalizedKeyword)) continue;
    decisions.push({
      keyword: keyword.keyword,
      normalizedKeyword: keyword.normalizedKeyword,
      tokenCount: keywordTokens(keyword.normalizedKeyword).length,
      parentSupport: keyword.sources.filter((source) => source.type === 'surfer_related').length,
      parentSupportTier: 0,
      bestOverlap: maxNullable(
        keyword.sources
          .filter((source): source is Extract<KeywordSource, { type: 'surfer_related' }> => source.type === 'surfer_related')
          .map((source) => source.overlap ?? null),
      ),
      maxVolume: null,
      broadeningOnly: false,
      supportingParents: keyword.sources
        .filter((source): source is Extract<KeywordSource, { type: 'surfer_related' }> => source.type === 'surfer_related')
        .map((source) => normalizeKeyword(source.parentKeyword))
        .sort(),
      selected: false,
      reason: 'global_budget',
      selectedFinal: true,
      committedBefore: true,
    });
  }
  decisions.sort((a, b) =>
    Number(b.selectedFinal) - Number(a.selectedFinal)
      || Number(b.committedBefore) - Number(a.committedBefore)
      || a.normalizedKeyword.localeCompare(b.normalizedKeyword),
  );

  await writeExpansionAdmissionArtifacts(input.runDirectory, {
    admission,
    decisions,
    committedBeforeCount: committedKeywords.length,
    addedCount: addedKeywords.length,
  });

  return {
    admission,
    decisions,
    committedBeforeCount: committedKeywords.length,
    addedKeywords,
  };
}

function toAdmissionOccurrence(row: StoredRelatedKeyword): ExpansionRelatedOccurrence {
  return {
    parentIdx: row.parentIdx,
    parentKeyword: row.parentKeyword,
    relatedKeyword: row.relatedKeyword,
    overlap: row.overlap,
    volume: row.volume,
    status: row.status,
  };
}

function expansionSources(
  related: ReadonlyArray<StoredRelatedKeyword>,
  normalizedKeyword: string,
): KeywordSource[] {
  const byParent = new Map<number, StoredRelatedKeyword>();
  for (const row of related) {
    if (row.status !== 'ok' || normalizeKeyword(row.relatedKeyword) !== normalizedKeyword) continue;
    const previous = byParent.get(row.parentIdx);
    if (previous === undefined || compareNullableDesc(row.overlap, previous.overlap) < 0) {
      byParent.set(row.parentIdx, row);
    }
  }
  return [...byParent.values()]
    .sort((a, b) => a.parentIdx - b.parentIdx)
    .map((row) => ({
      type: 'surfer_related' as const,
      parentKeyword: row.parentKeyword,
      overlap: row.overlap,
    }));
}

function rewriteSelectedRelatedFlags(
  store: RunStore,
  runId: string,
  related: ReadonlyArray<StoredRelatedKeyword>,
  selectedNormalized: ReadonlySet<string>,
): void {
  const byParent = new Map<number, StoredRelatedKeyword[]>();
  for (const row of related) {
    const existing = byParent.get(row.parentIdx) ?? [];
    existing.push(row);
    byParent.set(row.parentIdx, existing);
  }
  for (const rows of byParent.values()) {
    const okRows = rows.filter((row) => row.status === 'ok');
    if (okRows.length === 0) continue;
    const parent = okRows[0]!;
    const selectedRaw = new Set(
      okRows
        .filter((row) => selectedNormalized.has(normalizeKeyword(row.relatedKeyword)))
        .map((row) => row.relatedKeyword),
    );
    store.recordRelatedKeywords(
      runId,
      parent.parentIdx,
      parent.parentKeyword,
      {
        status: 'ok',
        error: null,
        rows: okRows.map((row) => ({
          keyword: row.relatedKeyword,
          overlap: row.overlap,
          volume: row.volume,
        })),
      },
      selectedRaw,
    );
  }
}

async function writeExpansionAdmissionArtifacts(
  runDirectory: string,
  value: {
    admission: ExpansionAdmissionResult;
    decisions: ExpansionFrontierDecision[];
    committedBeforeCount: number;
    addedCount: number;
  },
): Promise<void> {
  const jsonPath = join(runDirectory, 'expansion-admission.json');
  const csvPath = join(runDirectory, 'expansion-admission.csv');
  const reasonCounts = new Map<string, number>();
  for (const decision of value.decisions) {
    reasonCounts.set(decision.reason, (reasonCounts.get(decision.reason) ?? 0) + 1);
  }
  await writeJsonAtomic(jsonPath, {
    version: value.admission.version,
    policy: value.admission.policy,
    originalKeywordCount: value.admission.originalKeywordCount,
    rawCandidateCount: value.admission.rawCandidateCount,
    eligibleCandidateCount: value.admission.eligibleCandidateCount,
    budget: value.admission.budget,
    policySelectedCount: value.admission.selectedCount,
    committedBeforeCount: value.committedBeforeCount,
    addedCount: value.addedCount,
    finalSelectedCount: value.decisions.filter((decision) => decision.selectedFinal).length,
    reasonCounts: Object.fromEntries([...reasonCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    decisions: value.decisions,
  }, 'expansion admission report');

  const header = [
    'keyword',
    'normalized_keyword',
    'token_count',
    'parent_support',
    'parent_support_tier',
    'best_overlap',
    'max_volume',
    'broadening_only',
    'policy_selected',
    'selected_final',
    'committed_before',
    'reason',
    'supporting_parents',
  ];
  const lines = [header.join(',')];
  for (const decision of value.decisions) {
    lines.push([
      decision.keyword,
      decision.normalizedKeyword,
      decision.tokenCount,
      decision.parentSupport,
      decision.parentSupportTier,
      decision.bestOverlap ?? '',
      decision.maxVolume ?? '',
      decision.broadeningOnly,
      decision.selected,
      decision.selectedFinal,
      decision.committedBefore,
      decision.reason,
      decision.supportingParents.join(' | '),
    ].map(csvCell).join(','));
  }
  await writeTextAtomic(csvPath, `${lines.join('\n')}\n`, 'expansion admission CSV');
}

function isExpansionKeyword(keyword: StoredKeyword): boolean {
  return keyword.sources.some((source) => source.type === 'surfer_related');
}

function keywordTokens(keyword: string): string[] {
  return keyword.match(/[\p{L}\p{N}]+/gu) ?? [];
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

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
