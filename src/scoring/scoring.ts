import type { SerpResult } from '../google/serp.js';
import type { KeywordRecord, KeywordStatus, SerpObservationStatus } from '../runs/run.js';
import { resolveSerpEvidence } from '../runs/serpEvidence.js';

export const SCORING_VERSION = '1.1.0';

export type DrThresholds = {
  veryWeakMax: number;
  weakMax: number;
  strongMin: number;
  strongMax: number;
};

// Documented default DR bands (see SCORING.md). Used whenever a run's
// configSnapshot predates the scoring section (legacy runs) or omits thresholds.
export const DEFAULT_DR_THRESHOLDS: DrThresholds = {
  veryWeakMax: 10,
  weakMax: 30,
  strongMin: 60,
  strongMax: 75,
};

// Resolves DR thresholds from an arbitrary config snapshot, tolerating legacy
// snapshots that carry no `scoring` section. Missing individual fields fall
// back to the documented defaults so scoring never throws on old runs.
export function resolveDrThresholds(
  snapshot: { scoring?: { drThresholds?: Partial<DrThresholds> } } | null | undefined,
): DrThresholds {
  const fromSnapshot = snapshot?.scoring?.drThresholds;
  if (!fromSnapshot) return { ...DEFAULT_DR_THRESHOLDS };
  return {
    veryWeakMax: fromSnapshot.veryWeakMax ?? DEFAULT_DR_THRESHOLDS.veryWeakMax,
    weakMax: fromSnapshot.weakMax ?? DEFAULT_DR_THRESHOLDS.weakMax,
    strongMin: fromSnapshot.strongMin ?? DEFAULT_DR_THRESHOLDS.strongMin,
    strongMax: fromSnapshot.strongMax ?? DEFAULT_DR_THRESHOLDS.strongMax,
  };
}

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
  serpStatus: SerpObservationStatus;
  serpErrorCode: string | null;
  serpErrorMessage: string | null;
  organicResultCount: number | null;
  uniqueDomains: number | null;
  knownUniqueDomains: number | null;
  minDr: number | null;
  maxDr: number | null;
  medianDr: number | null;
  top3MedianDr: number | null;
  top5MedianDr: number | null;
  veryWeakDomainsCount: number | null;
  weakDomainsCount: number | null;
  strongDomainsCount: number | null;
  veryStrongDomainsCount: number | null;
  missingDrCount: number | null;
  exactMatchDomainCount: number | null;
  nicheDomainCount: number | null;
  serpDiversity: number | null;
  surferVolume: number | null;
  surferCpc: number | null;
  score: number | null;
  tier: 'A' | 'B' | 'C' | 'D' | null;
  scoringVersion: string;
  rationale: string;
  // Completeness metadata: whether the numeric score is based on full DR data.
  // 'complete' when every SERP domain has numeric DR; 'degraded' otherwise.
  // This does not change the score — it only records evidence completeness.
  scoringCompleteness: 'complete' | 'degraded';
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

// Label of a registrable domain used for exact-match: the second-level domain
// (the first label of the registrable domain). For "example.co.uk" this is
// "example", for "comparelists.com" it is "comparelists". Registrable domains
// already exclude subdomains, so the first label is the brand label.
function domainLabel(domain: string): string {
  const labels = domain.split('.');
  return normalizeLabel(labels[0] ?? domain);
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
  let nicheDomainCount = 0;
  const tokens = keywordTokens(input.keyword);
  // Exact-match domains (whose brand label equals the keyword) are counted
  // once and then excluded from the niche heuristic, so a domain that is an
  // exact match never double-counts as a niche signal for the same keyword.
  for (const domain of representative.keys()) {
    const label = domainLabel(domain);
    if (label.length > 0 && label === normalizedKeyword) {
      exactMatchDomainCount += 1;
      continue;
    }
    if (tokens.length > 0) {
      const normalizedDomain = normalizeLabel(domain);
      if (
        normalizedDomain.length > 0 &&
        tokens.some((token) => normalizedDomain.includes(token))
      ) {
        nicheDomainCount += 1;
      }
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
  scoringCompleteness: 'complete' | 'degraded';
};

export function score(
  features: AggregationFeatures,
  status: KeywordStatus,
  surferVolume: number | null,
  surferCpc: number | null,
): ScoreResult {
  // Failed / non-terminal keywords remain observable but unscored.
  if (status !== 'completed' && status !== 'partial') {
    return { score: null, tier: null, rationale: '', scoringCompleteness: 'degraded' };
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

  // Scoring completeness: 'complete' only when every SERP domain has numeric DR.
  // Missing DR stays missing — it never becomes zero. A degraded score is still
  // deterministic under the existing formula but must not be presented as fully
  // evidenced without this adjacent status.
  const scoringCompleteness: 'complete' | 'degraded' =
    features.missingDrCount === 0 && known > 0 ? 'complete' : 'degraded';

  return { score: rounded, tier, rationale, scoringCompleteness };
}

export function buildCandidates(
  keywords: Array<{
    idx: number;
    keyword: string;
    normalizedKeyword: string;
    status: KeywordStatus;
    error: { code: string; message: string } | null;
    surfer: { volume: number | null; cpc: number | null } | null;
    google?: KeywordRecord['google'];
  }>,
  serpRows: SerpResult[],
  thresholds: DrThresholds,
): Candidate[] {
  const byKeywordIdx = new Map<number, SerpResult[]>();
  for (const row of serpRows) {
    if (row.keywordIdx === undefined) continue;
    const existing = byKeywordIdx.get(row.keywordIdx) ?? [];
    existing.push(row);
    byKeywordIdx.set(row.keywordIdx, existing);
  }

  const candidates: Candidate[] = keywords.map((keyword) => {
    const rows = byKeywordIdx.get(keyword.idx) ?? [];
    const evidence = resolveSerpEvidence(
      {
        status: keyword.status,
        error: keyword.error,
        google: keyword.google ?? null,
      },
      rows.length,
    );
    const features = aggregate(
      {
        keyword: keyword.keyword,
        normalizedKeyword: keyword.normalizedKeyword,
        surfer: keyword.surfer,
        serpRows: rows,
      },
      thresholds,
    );
    // Score v1.1 keeps the v1.0 formula unchanged but only applies it when the
    // SERP observation is trustworthy. Missing/failed/ambiguous SERP evidence
    // stays unscored instead of being interpreted as an empty competitive set.
    const result = evidence.trustworthy
      ? score(
          features,
          keyword.status,
          keyword.surfer?.volume ?? null,
          keyword.surfer?.cpc ?? null,
        )
      : { score: null, tier: null, rationale: '', scoringCompleteness: 'degraded' as const };

    return {
      keyword: keyword.keyword,
      normalizedKeyword: keyword.normalizedKeyword,
      status: keyword.status,
      errorCode: keyword.error?.code ?? null,
      errorMessage: keyword.error?.message ?? null,
      serpStatus: evidence.status,
      serpErrorCode: evidence.errorCode,
      serpErrorMessage: evidence.errorMessage,
      organicResultCount: evidence.organicResultCount,
      uniqueDomains: evidence.trustworthy ? features.uniqueDomains : null,
      knownUniqueDomains: evidence.trustworthy ? features.knownUniqueDomains : null,
      minDr: evidence.trustworthy ? features.minDr : null,
      maxDr: evidence.trustworthy ? features.maxDr : null,
      medianDr: evidence.trustworthy ? features.medianDr : null,
      top3MedianDr: evidence.trustworthy ? features.top3MedianDr : null,
      top5MedianDr: evidence.trustworthy ? features.top5MedianDr : null,
      veryWeakDomainsCount: evidence.trustworthy ? features.veryWeakDomainsCount : null,
      weakDomainsCount: evidence.trustworthy ? features.weakDomainsCount : null,
      strongDomainsCount: evidence.trustworthy ? features.strongDomainsCount : null,
      veryStrongDomainsCount: evidence.trustworthy ? features.veryStrongDomainsCount : null,
      missingDrCount: evidence.trustworthy ? features.missingDrCount : null,
      exactMatchDomainCount: evidence.trustworthy ? features.exactMatchDomainCount : null,
      nicheDomainCount: evidence.trustworthy ? features.nicheDomainCount : null,
      serpDiversity: evidence.trustworthy ? features.serpDiversity : null,
      surferVolume: keyword.surfer?.volume ?? null,
      surferCpc: keyword.surfer?.cpc ?? null,
      score: result.score,
      tier: result.tier,
      scoringVersion: SCORING_VERSION,
      rationale: result.rationale,
      scoringCompleteness: result.scoringCompleteness,
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
