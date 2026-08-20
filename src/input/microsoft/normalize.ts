import { normalizeKeyword } from '../seeds/normalize.js';

export type MicrosoftRow = {
  adGroup: string;
  keyword: string;
  volumeBucket: string | null;
  competition: string | null;
  cpc: number | null;
  rowNumber: number;
};

export type MicrosoftKeyword = {
  keyword: string;
  normalizedKeyword: string;
  sourceRows: number[];
  adGroup: string;
  microsoft: {
    volumeBucket?: string | null;
    volumeRaw?: number | null;
    competition?: string | null;
    cpc?: number | null;
  };
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

export function buildMicrosoftKeywords(rows: MicrosoftRow[]): MicrosoftKeyword[] {
  const byNormalized = new Map<string, MicrosoftKeyword>();

  for (const row of rows) {
    const normalizedKeyword = normalizeKeyword(row.keyword);
    const existing = byNormalized.get(normalizedKeyword);

    if (existing) {
      existing.sourceRows.push(row.rowNumber);
      continue;
    }

    byNormalized.set(normalizedKeyword, {
      keyword: row.keyword,
      normalizedKeyword,
      sourceRows: [row.rowNumber],
      adGroup: row.adGroup,
      microsoft: {
        volumeBucket: row.volumeBucket,
        volumeRaw: parseVolumeBucketUpper(row.volumeBucket),
        competition: row.competition,
        cpc: row.cpc,
      },
    });
  }

  return Array.from(byNormalized.values());
}
