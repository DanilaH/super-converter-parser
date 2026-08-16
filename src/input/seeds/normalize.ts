export type SeedRow = {
  keyword: string;
  rowNumber: number;
};

export type SeedKeyword = {
  keyword: string;
  normalizedKeyword: string;
  sourceRows: number[];
};

export function normalizeKeyword(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function buildSeedKeywords(rows: SeedRow[]): SeedKeyword[] {
  const byNormalized = new Map<string, SeedKeyword>();

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
    });
  }

  return Array.from(byNormalized.values());
}