import { normalizeKeyword } from '../seeds/normalize.js';

export type MicrosoftRow = {
  adGroup: string;
  keyword: string;
  volumeBucket: string | null;
  competition: string | null;
  cpc: number | null;
  rowNumber: number;
};

// One Microsoft source row that contributed to a canonical keyword. Every
// occurrence is preserved (not just the first), so duplicate keywords keep
// their per-row ad group, volume, competition, and CPC provenance.
export type MicrosoftOccurrence = {
  sourceRow: number;
  adGroup: string;
  volumeBucket: string | null;
  volumeRaw: number | null;
  competition: string | null;
  cpc: number | null;
};

// The single aggregated Microsoft signal carried on the keyword record. It is
// chosen deterministically from the occurrences by `aggregateMicrosoft`, never
// implicitly "the first row".
export type MicrosoftAggregate = {
  volumeBucket: string | null;
  volumeRaw: number | null;
  competition: string | null;
  cpc: number | null;
};

export type MicrosoftKeyword = {
  keyword: string;
  normalizedKeyword: string;
  sourceRows: number[];
  occurrences: MicrosoftOccurrence[];
  microsoft: MicrosoftAggregate;
};

const UNIT_MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

// Microsoft reports search volume as a bucket range (e.g. "100 - 1K"). There is
// no exact count, so we expose the upper bound as a rough numeric signal for
// later prioritization. A malformed or missing bucket yields null.
export function parseVolumeBucketUpper(bucket: string | null): number | null {
  if (!bucket) return null;
  const parts = bucket.split('-');
  if (parts.length !== 2) return null;
  const upperRaw = parts[1];
  if (upperRaw === undefined) return null;
  const upper = upperRaw.trim().toLowerCase();
  const match = /^([\d.]+)\s*([kmb])?$/.exec(upper);
  if (!match) return null;
  const valueStr = match[1];
  if (valueStr === undefined) return null;
  const value = Number(valueStr);
  if (!Number.isFinite(value)) return null;
  const unit = match[2];
  if (!unit) return value;
  const multiplier = UNIT_MULTIPLIERS[unit];
  return multiplier === undefined ? value : value * multiplier;
}

// Choose the primary occurrence that represents a keyword's aggregated
// Microsoft signal. The rule is explicit and deterministic (never "first
// row"): prefer the occurrence with the most populated signal fields; ties
// break to the lowest source row. This keeps aggregation stable across
// create/load/resume and avoids silently favoring one input row.
export function aggregateMicrosoft(occurrences: MicrosoftOccurrence[]): MicrosoftAggregate {
  if (occurrences.length === 0) {
    return { volumeBucket: null, volumeRaw: null, competition: null, cpc: null };
  }
  const score = (o: MicrosoftOccurrence): number =>
    (o.volumeBucket !== null ? 1 : 0) +
    (o.volumeRaw !== null ? 1 : 0) +
    (o.competition !== null ? 1 : 0) +
    (o.cpc !== null ? 1 : 0);

  let best = occurrences[0]!;
  let bestScore = score(best);
  for (let i = 1; i < occurrences.length; i += 1) {
    const candidate = occurrences[i]!;
    const candidateScore = score(candidate);
    if (
      candidateScore > bestScore ||
      (candidateScore === bestScore && candidate.sourceRow < best.sourceRow)
    ) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return {
    volumeBucket: best.volumeBucket,
    volumeRaw: best.volumeRaw,
    competition: best.competition,
    cpc: best.cpc,
  };
}

export function buildMicrosoftKeywords(rows: MicrosoftRow[]): MicrosoftKeyword[] {
  const byNormalized = new Map<string, MicrosoftKeyword>();

  for (const row of rows) {
    const normalizedKeyword = normalizeKeyword(row.keyword);
    const occurrence: MicrosoftOccurrence = {
      sourceRow: row.rowNumber,
      adGroup: row.adGroup,
      volumeBucket: row.volumeBucket,
      volumeRaw: parseVolumeBucketUpper(row.volumeBucket),
      competition: row.competition,
      cpc: row.cpc,
    };

    const existing = byNormalized.get(normalizedKeyword);
    if (existing) {
      existing.occurrences.push(occurrence);
      existing.sourceRows.push(row.rowNumber);
      continue;
    }

    byNormalized.set(normalizedKeyword, {
      keyword: row.keyword,
      normalizedKeyword,
      sourceRows: [row.rowNumber],
      occurrences: [occurrence],
      microsoft: aggregateMicrosoft([occurrence]),
    });
  }

  // Recompute the aggregate against all occurrences (not just the first seen
  // row), so the chosen primary reflects the full set of duplicates.
  for (const keyword of byNormalized.values()) {
    keyword.microsoft = aggregateMicrosoft(keyword.occurrences);
  }

  return Array.from(byNormalized.values());
}
