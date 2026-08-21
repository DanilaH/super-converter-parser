import type { SerpResult } from '../google/serp.js';
import type { KeywordStatus } from '../runs/run.js';

export const SCORING_VERSION = '1.0.0';

export type DrThresholds = {
  veryWeakMax: number;
  weakMax: number;
  strongMin: number;
  strongMax: number;
};

export type AggregationFeatures = {
  organicResultCount: number;
  uniqueDomains: number;
  knownUniqueDomains: number;
  minDr: number | null;
  maxDr: number | null;
  medianDr: number | null;
  top3MedianDr: number | null;
  top5MedianDr: number | null;
  veryWeakDomainsCount: number;
  weakDomainsCount: number;
  strongDomainsCount: number;
  veryStrongDomainsCount: number;
  missingDrCount: number;
  exactMatchDomainCount: number;
  nicheDomainCount: number;
  serpDiversity: number;
};

export type Candidate = {
  keyword: string;
  normalizedKeyword: string;
  status: KeywordStatus;
  errorCode: string | null;
  errorMessage: string | null;
  organicResultCount: number;
  uniqueDomains: number;
  knownUniqueDomains: number;
  minDr: number | null;
  maxDr: number | null;
  medianDr: number | null;
  top3MedianDr: number | null;
  top5MedianDr: number | null;
  veryWeakDomainsCount: number;
  weakDomainsCount: number;
  strongDomainsCount: number;
  veryStrongDomainsCount: number;
  missingDrCount: number;
  exactMatchDomainCount: number;
  nicheDomainCount: number;
  serpDiversity: number;
  surferVolume: number | null;
  surferCpc: number | null;
  score: number | null;
  tier: 'A' | 'B' | 'C' | 'D' | null;
  scoringVersion: string;
  rationale: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  const lower = sorted[middle - 1] as number;
  const upper = sorted[middle] as number;
  return (lower + upper) / 2;
}

// NFKD + lowercase + strip non-alphanumerics. Used for exact-match and niche
// classification (see SCORING.md).
function normalizeLabel(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Split a keyword into token labels (each normalized) of length >= 4, used by
// the niche-domain heuristic. Original word boundaries are preserved before
// normalization so "compare lists" yields ["compare", "lists"].
function keywordTokens(keyword: string): string[] {
  return keyword
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length >= 4);
}

export type AggregateInput = {
  keyword: string;
  normalizedKeyword: string;
  surfer: { volume: number | null; cpc: number | null } | null;
  serpRows: SerpResult[];
};

export function aggregate(input: AggregateInput, thresholds: DrThresholds): AggregationFeatures {
  const serpRows = input.serpRows;
  const organicResultCount = serpRows.length;

  // Representative DR per unique registrable domain: the first organic position.
  const representative = new Map<
    string,
    { position: number; dr: number | null; drStatus: SerpResult['drStatus'] }
  >();
  for (const row of serpRows) {
    const domain = row.registrableDomain;
    if (!domain) continue;
    const existing = representative.get(domain);
    if (existing === undefined || row.position < existing.position) {
      representative.set(domain, { position: row.position, dr: row.dr, drStatus: row.drStatus });
    }
  }

  const uniqueDomains = representative.size;
  const knownDrs: number[] = [];
  let missingDrCount = 0;
  let veryWeakDomainsCount = 0;
  let weakDomainsCount = 0;
  let strongDomainsCount = 0;
  let veryStrongDomainsCount = 0;

  for (const rep of representative.values()) {
    if (rep.dr === null) {
      missingDrCount += 1;
      continue;
    }
    knownDrs.push(rep.dr);
    if (rep.dr < thresholds.veryWeakMax) veryWeakDomainsCount += 1;
    else if (rep.dr < thresholds.weakMax) weakDomainsCount += 1;
    else if (rep.dr < thresholds.strongMin) {
      // neutral band: counted in knownDrs, no dedicated counter
    } else if (rep.dr < thresholds.strongMax) strongDomainsCount += 1;
    else veryStrongDomainsCount += 1;
  }

  const knownUniqueDomains = uniqueDomains - missingDrCount;

  const topNMedian = (n: number): number | null => {
    const drs: number[] = [];
    for (const row of serpRows) {
      if (row.position >= 1 && row.position <= n && row.dr !== null) drs.push(row.dr);
    }
    return median(drs);
  };

  const normalizedKeyword = normalizeLabel(input.normalizedKeyword);
  let exactMatchDomainCount = 0;
  for (const domain of representative.keys()) {
    const normalizedDomain = normalizeLabel(domain);
    if (normalizedDomain.length > 0 && normalizedDomain === normalizedKeyword) {
      exactMatchDomainCount += 1;
    }
  }

  const tokens = keywordTokens(input.keyword);
  let nicheDomainCount = 0;
  if (tokens.length > 0) {
    for (const domain of representative.keys()) {
      const normalizedDomain = normalizeLabel(domain);
      if (normalizedDomain.length === 0) continue;
      if (normalizedDomain === normalizedKeyword) continue; // exact match handled above
      if (tokens.some((token) => normalizedDomain.includes(token))) nicheDomainCount += 1;
    }
  }

  const serpDiversity = organicResultCount > 0 ? uniqueDomains / organicResultCount : 0;

  return {
    organicResultCount,
    uniqueDomains,
    knownUniqueDomains,
    minDr: knownDrs.length > 0 ? Math.min(...knownDrs) : null,
    maxDr: knownDrs.length > 0 ? Math.max(...knownDrs) : null,
    medianDr: median(knownDrs),
    top3MedianDr: topNMedian(3),
    top5MedianDr: topNMedian(5),
    veryWeakDomainsCount,
    weakDomainsCount,
    strongDomainsCount,
    veryStrongDomainsCount,
    missingDrCount,
    exactMatchDomainCount,
    nicheDomainCount,
    serpDiversity,
  };
}

export type ScoreResult = {
  score: number | null;
  tier: 'A' | 'B' | 'C' | 'D' | null;
  rationale: string;
};

export function score(
  features: AggregationFeatures,
  status: KeywordStatus,
  surferVolume: number | null,
  surferCpc: number | null,
): ScoreResult {
  // Failed / non-terminal keywords remain observable but unscored.
  if (status !== 'completed' && status !== 'partial') {
    return { score: null, tier: null, rationale: '' };
  }

  const volume = surferVolume ?? 0;
  const cpc = surferCpc ?? 0;

  const demand = 30 * clamp(Math.log1p(volume) / Math.log1p(100_000), 0, 1);

  const known = features.knownUniqueDomains;
  const medianComponent =
    features.medianDr === null ? 0 : 15 * (1 - clamp(features.medianDr / 80, 0, 1));
  const weakComponent =
    known === 0 ? 0 : 15 * clamp((features.veryWeakDomainsCount + features.weakDomainsCount) / known, 0, 1);
  const top3Component =
    features.top3MedianDr === null ? 0 : 10 * (1 - clamp(features.top3MedianDr / 80, 0, 1));
  const accessibility = medianComponent + weakComponent + top3Component;

  const commercial = 10 * clamp(Math.log1p(cpc) / Math.log1p(20), 0, 1);
  const diversity = 10 * features.serpDiversity;
  const completeness =
    (features.uniqueDomains === 0 ? 0 : 6 * clamp(known / features.uniqueDomains, 0, 1)) +
    (surferVolume !== null ? 2 : 0) +
    (features.organicResultCount > 0 ? 2 : 0);

  const raw = demand + accessibility + commercial + diversity + completeness;
  const rounded = Math.round(raw * 100) / 100;

  const tier: ScoreResult['tier'] =
    rounded >= 75 ? 'A' : rounded >= 55 ? 'B' : rounded >= 35 ? 'C' : 'D';

  const rationale = [
    `volume=${surferVolume ?? '-'}`,
    `cpc=${surferCpc ?? '-'}`,
    `organic=${features.organicResultCount}`,
    `uniqueDomains=${features.uniqueDomains}`,
    `known=${known}`,
    `weak=${features.veryWeakDomainsCount + features.weakDomainsCount}`,
    `minDr=${features.minDr ?? '-'}`,
    `top3MedianDr=${features.top3MedianDr ?? '-'}`,
    `medianDr=${features.medianDr ?? '-'}`,
  ].join(' ');

  return { score: rounded, tier, rationale };
}

export function buildCandidates(
  keywords: Array<{
    keyword: string;
    normalizedKeyword: string;
    status: KeywordStatus;
    error: { code: string; message: string } | null;
    surfer: { volume: number | null; cpc: number | null } | null;
  }>,
  serpRows: SerpResult[],
  thresholds: DrThresholds,
): Candidate[] {
  const byKeyword = new Map<string, SerpResult[]>();
  for (const row of serpRows) {
    const existing = byKeyword.get(row.keyword) ?? [];
    existing.push(row);
    byKeyword.set(row.keyword, existing);
  }

  const candidates: Candidate[] = keywords.map((keyword) => {
    const rows = byKeyword.get(keyword.keyword) ?? [];
    const features = aggregate(
      {
        keyword: keyword.keyword,
        normalizedKeyword: keyword.normalizedKeyword,
        surfer: keyword.surfer,
        serpRows: rows,
      },
      thresholds,
    );
    const result = score(
      features,
      keyword.status,
      keyword.surfer?.volume ?? null,
      keyword.surfer?.cpc ?? null,
    );
    return {
      keyword: keyword.keyword,
      normalizedKeyword: keyword.normalizedKeyword,
      status: keyword.status,
      errorCode: keyword.error?.code ?? null,
      errorMessage: keyword.error?.message ?? null,
      ...features,
      surferVolume: keyword.surfer?.volume ?? null,
      surferCpc: keyword.surfer?.cpc ?? null,
      score: result.score,
      tier: result.tier,
      scoringVersion: SCORING_VERSION,
      rationale: result.rationale,
    };
  });

  candidates.sort((a, b) => {
    if (a.score === null && b.score === null) {
      // fall through to volume/keyword
    } else if (a.score === null) {
      return 1;
    } else if (b.score === null) {
      return -1;
    } else if (a.score !== b.score) {
      return b.score - a.score;
    }

    const va = a.surferVolume;
    const vb = b.surferVolume;
    if (va === null && vb === null) {
      // fall through
    } else if (va === null) {
      return 1;
    } else if (vb === null) {
      return -1;
    } else if (va !== vb) {
      return vb - va;
    }

    if (a.normalizedKeyword < b.normalizedKeyword) return -1;
    if (a.normalizedKeyword > b.normalizedKeyword) return 1;
    return 0;
  });

  return candidates;
}
