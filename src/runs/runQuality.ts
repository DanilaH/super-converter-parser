import type {
  StoredDomain,
  StoredKeyword,
  StoredRelatedKeyword,
  StoredRun,
} from '../db/store.js';
import type { SerpResult } from '../google/serp.js';
import type { AhrefsSummary } from './engine.js';
import { TERMINAL_RUN_STATES, type RunState } from './run.js';
import { resolveSerpEvidence } from './serpEvidence.js';

export const RUN_QUALITY_VERSION = '1.0.0';

export type RunQualityWarning = {
  code:
    | 'GOOGLE_SERP_INCOMPLETE'
    | 'SURFER_INCOMPLETE'
    | 'RELATED_ERRORS'
    | 'RELATED_NOT_ATTEMPTED'
    | 'AHREFS_ERRORS'
    | 'AHREFS_NOT_ATTEMPTED'
    | 'AHREFS_NUMERIC_INCOMPLETE'
    | 'GEO_MISMATCH'
    | 'GEO_LOGICAL_ONLY'
    | 'GEO_UNKNOWN';
  affected: number;
  denominator: number | null;
  message: string;
};

export type RunQuality = {
  version: typeof RUN_QUALITY_VERSION;
  runId: string;
  state: RunState;
  runStateUpdatedAt: string;
  sources: {
    googleSerp: {
      denominator: number;
      trustworthy: number;
      coveragePercent: number | null;
      statuses: {
        ok: number;
        empty: number;
        fetchError: number;
        parseError: number;
        notFetched: number;
        unknown: number;
      };
    };
    surfer: {
      denominator: number;
      observed: number;
      coveragePercent: number | null;
      volumeAvailable: number;
      cpcAvailable: number;
      statuses: {
        ok: number;
        error: number;
        notFetched: number;
        unknown: number;
      };
    };
    related: {
      denominator: number;
      successful: number;
      coveragePercent: number | null;
      realRows: number;
      statuses: {
        ok: number;
        empty: number;
        error: number;
        notAttempted: number;
      };
    };
    ahrefs: {
      denominator: number;
      resolved: number;
      resolvedCoveragePercent: number | null;
      numeric: number;
      numericCoveragePercent: number | null;
      mode: 'required' | 'optional';
      summaryState: AhrefsSummary['state'] | null;
      statuses: {
        ok: number;
        notFound: number;
        error: number;
        notAttempted: number;
      };
    };
  };
  geo: {
    grade: 'verified' | 'logical_only' | 'mismatch' | 'unknown';
    targetMarket: string;
    googleHl: string;
    googleGl: string;
    detectedKeywords: number;
    trustworthyDetectedKeywords: number;
    mismatchKeywords: number;
    detectedLocations: string[];
  };
  bounds: {
    organicSerpTopN: number;
    relatedExpansion: {
      enabled: boolean | null;
      depth: number | null;
      maxCandidatesPerKeyword: number | null;
      minOverlap: number | null;
      minVolume: number | null;
      selectedRows: number;
      explicitOmissionCount: null;
      omissionAccounting: 'not_persisted';
    };
  };
  warnings: RunQualityWarning[];
};

type BuildRunQualityInput = {
  run: StoredRun;
  state: RunState;
  keywords: StoredKeyword[];
  serpRows: SerpResult[];
  relatedKeywords: StoredRelatedKeyword[];
  domains: StoredDomain[];
  ahrefs?: AhrefsSummary;
};

type RelatedSummary = {
  denominator: number;
  realRows: number;
  ok: number;
  empty: number;
  error: number;
  notAttempted: number;
};

function coveragePercent(observed: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((observed / denominator) * 100);
}

function surferObservation(keyword: StoredKeyword): 'ok' | 'error' | 'notFetched' | 'unknown' {
  if (keyword.surfer !== null) return 'ok';
  if (keyword.status === 'pending' || keyword.status === 'running') return 'notFetched';
  if (keyword.error?.code === 'SURFER_PARSE_ERROR' || keyword.error?.code === 'SURFER_NOT_DETECTED') {
    return 'error';
  }
  if (
    keyword.google?.serpStatus === 'fetch_error' ||
    keyword.error?.code === 'GOOGLE_UNAVAILABLE' ||
    keyword.error?.code === 'BROWSER_CONNECTION_ERROR' ||
    keyword.error?.code === 'CAPTCHA_REQUIRED'
  ) {
    return 'notFetched';
  }
  return 'unknown';
}

function relatedParentOutcomes(
  keywords: StoredKeyword[],
  relatedKeywords: StoredRelatedKeyword[],
): RelatedSummary {
  const rootKeywordIdxs = new Set(
    keywords
      .filter((keyword) => !keyword.sources.some((source) => source.type === 'surfer_related'))
      .map((keyword) => keyword.idx),
  );
  const outcomes = new Map<number, 'ok' | 'empty' | 'error'>();
  let realRows = 0;

  for (const row of relatedKeywords) {
    if (!rootKeywordIdxs.has(row.parentIdx)) continue;
    if (row.status === 'ok' && row.relatedKeyword.trim() !== '') realRows += 1;
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
    denominator: rootKeywordIdxs.size,
    realRows,
    ok,
    empty,
    error,
    notAttempted: rootKeywordIdxs.size - outcomes.size,
  };
}

function makeWarning(
  code: RunQualityWarning['code'],
  affected: number,
  denominator: number | null,
  message: string,
): RunQualityWarning {
  return { code, affected, denominator, message };
}

export function buildRunQuality(input: BuildRunQualityInput): RunQuality {
  const { run, state, keywords, serpRows, relatedKeywords, domains, ahrefs } = input;
  const terminal = TERMINAL_RUN_STATES.has(state);
  const serpCounts = new Map<number, number>();
  for (const row of serpRows) {
    if (row.keywordIdx === undefined) continue;
    serpCounts.set(row.keywordIdx, (serpCounts.get(row.keywordIdx) ?? 0) + 1);
  }

  const googleStatuses = {
    ok: 0,
    empty: 0,
    fetchError: 0,
    parseError: 0,
    notFetched: 0,
    unknown: 0,
  };
  const trustworthyKeywordIdxs = new Set<number>();
  for (const keyword of keywords) {
    const evidence = resolveSerpEvidence(
      { status: keyword.status, error: keyword.error, google: keyword.google },
      serpCounts.get(keyword.idx) ?? 0,
    );
    if (evidence.status === 'ok') {
      googleStatuses.ok += 1;
      trustworthyKeywordIdxs.add(keyword.idx);
    } else if (evidence.status === 'empty') {
      googleStatuses.empty += 1;
      trustworthyKeywordIdxs.add(keyword.idx);
    } else if (evidence.status === 'fetch_error') googleStatuses.fetchError += 1;
    else if (evidence.status === 'parse_error') googleStatuses.parseError += 1;
    else if (evidence.status === 'not_fetched') googleStatuses.notFetched += 1;
    else googleStatuses.unknown += 1;
  }
  const googleTrustworthy = trustworthyKeywordIdxs.size;

  const surferStatuses = { ok: 0, error: 0, notFetched: 0, unknown: 0 };
  let surferVolumeAvailable = 0;
  let surferCpcAvailable = 0;
  for (const keyword of keywords) {
    surferStatuses[surferObservation(keyword)] += 1;
    if (keyword.surfer?.volume !== null && keyword.surfer?.volume !== undefined) surferVolumeAvailable += 1;
    if (keyword.surfer?.cpc !== null && keyword.surfer?.cpc !== undefined) surferCpcAvailable += 1;
  }

  const related = relatedParentOutcomes(keywords, relatedKeywords);
  const relatedSuccessful = related.ok + related.empty;

  const ahrefsStatuses = { ok: 0, notFound: 0, error: 0, notAttempted: 0 };
  let ahrefsNumeric = 0;
  for (const domain of domains) {
    if (domain.status === 'ok') ahrefsStatuses.ok += 1;
    else if (domain.status === 'not_found') ahrefsStatuses.notFound += 1;
    else if (domain.status === 'error') ahrefsStatuses.error += 1;
    else ahrefsStatuses.notAttempted += 1;
    if (domain.dr !== null) ahrefsNumeric += 1;
  }
  const ahrefsResolved = ahrefsStatuses.ok + ahrefsStatuses.notFound + ahrefsStatuses.error;
  // writeSnapshots can project old/resumed runs without a live Ahrefs tracker.
  // Only expose the tracker-level summary verdict when its discovered-domain
  // denominator agrees with the durable domain set; the per-domain projection
  // above remains authoritative either way.
  const ahrefsSummaryState = ahrefs && ahrefs.discovered === domains.length ? ahrefs.state : null;

  const detectedLocations = Array.from(
    new Set(
      keywords
        .map((keyword) => keyword.google?.detectedLocation ?? null)
        .filter((location): location is string => location !== null && location.trim() !== ''),
    ),
  ).sort((a, b) => a.localeCompare(b));
  const detectedKeywords = keywords.filter(
    (keyword) => (keyword.google?.detectedLocation ?? '').trim() !== '',
  ).length;
  const trustworthyDetectedKeywords = keywords.filter(
    (keyword) =>
      trustworthyKeywordIdxs.has(keyword.idx) &&
      (keyword.google?.detectedLocation ?? '').trim() !== '',
  ).length;
  const mismatchKeywords = keywords.filter((keyword) => keyword.google?.geoWarning === true).length;
  const geoGrade: RunQuality['geo']['grade'] = mismatchKeywords > 0
    ? 'mismatch'
    : googleTrustworthy === 0
      ? 'unknown'
      : trustworthyDetectedKeywords === googleTrustworthy
        ? 'verified'
        : 'logical_only';

  const warnings: RunQualityWarning[] = [];
  const googleUnavailable = keywords.length - googleTrustworthy;
  if (terminal && googleUnavailable > 0) {
    warnings.push(makeWarning(
      'GOOGLE_SERP_INCOMPLETE',
      googleUnavailable,
      keywords.length,
      `${googleUnavailable}/${keywords.length} keyword(s) lack trustworthy Google SERP evidence.`,
    ));
  }
  const surferUnavailable = keywords.length - surferStatuses.ok;
  if (terminal && surferUnavailable > 0) {
    warnings.push(makeWarning(
      'SURFER_INCOMPLETE',
      surferUnavailable,
      keywords.length,
      `${surferUnavailable}/${keywords.length} keyword(s) lack a successful Surfer observation.`,
    ));
  }
  if (related.error > 0) {
    warnings.push(makeWarning(
      'RELATED_ERRORS',
      related.error,
      related.denominator,
      `${related.error}/${related.denominator} root keyword(s) have related-keyword collection errors.`,
    ));
  }
  if (terminal && related.notAttempted > 0) {
    warnings.push(makeWarning(
      'RELATED_NOT_ATTEMPTED',
      related.notAttempted,
      related.denominator,
      `${related.notAttempted}/${related.denominator} root keyword(s) have no related-keyword observation.`,
    ));
  }
  if (ahrefsStatuses.error > 0) {
    warnings.push(makeWarning(
      'AHREFS_ERRORS',
      ahrefsStatuses.error,
      domains.length,
      `${ahrefsStatuses.error}/${domains.length} observed domain(s) have Ahrefs lookup errors.`,
    ));
  }
  if (terminal && ahrefsStatuses.notAttempted > 0) {
    warnings.push(makeWarning(
      'AHREFS_NOT_ATTEMPTED',
      ahrefsStatuses.notAttempted,
      domains.length,
      `${ahrefsStatuses.notAttempted}/${domains.length} observed domain(s) were not attempted by Ahrefs.`,
    ));
  }
  if (terminal && domains.length > 0 && ahrefsNumeric < domains.length) {
    warnings.push(makeWarning(
      'AHREFS_NUMERIC_INCOMPLETE',
      domains.length - ahrefsNumeric,
      domains.length,
      `${domains.length - ahrefsNumeric}/${domains.length} observed domain(s) lack numeric DR.`,
    ));
  }
  if (geoGrade === 'mismatch') {
    warnings.push(makeWarning(
      'GEO_MISMATCH',
      mismatchKeywords,
      keywords.length,
      `${mismatchKeywords}/${keywords.length} keyword(s) report detected Google location mismatch.`,
    ));
  } else if (terminal && geoGrade === 'logical_only') {
    const missingPhysical = googleTrustworthy - trustworthyDetectedKeywords;
    warnings.push(makeWarning(
      'GEO_LOGICAL_ONLY',
      missingPhysical,
      googleTrustworthy,
      `${missingPhysical}/${googleTrustworthy} trustworthy Google SERP observation(s) lack a detected physical location; geo evidence is only partially physical and otherwise logical hl/gl.`,
    ));
  } else if (terminal && geoGrade === 'unknown') {
    warnings.push(makeWarning(
      'GEO_UNKNOWN',
      0,
      keywords.length,
      'No trustworthy Google SERP observation is available to grade geo evidence.',
    ));
  }

  const expansion = run.configSnapshot.expansion;
  return {
    version: RUN_QUALITY_VERSION,
    runId: run.runId,
    state,
    runStateUpdatedAt: run.updatedAt,
    sources: {
      googleSerp: {
        denominator: keywords.length,
        trustworthy: googleTrustworthy,
        coveragePercent: coveragePercent(googleTrustworthy, keywords.length),
        statuses: googleStatuses,
      },
      surfer: {
        denominator: keywords.length,
        observed: surferStatuses.ok,
        coveragePercent: coveragePercent(surferStatuses.ok, keywords.length),
        volumeAvailable: surferVolumeAvailable,
        cpcAvailable: surferCpcAvailable,
        statuses: surferStatuses,
      },
      related: {
        denominator: related.denominator,
        successful: relatedSuccessful,
        coveragePercent: coveragePercent(relatedSuccessful, related.denominator),
        realRows: related.realRows,
        statuses: {
          ok: related.ok,
          empty: related.empty,
          error: related.error,
          notAttempted: related.notAttempted,
        },
      },
      ahrefs: {
        denominator: domains.length,
        resolved: ahrefsResolved,
        resolvedCoveragePercent: coveragePercent(ahrefsResolved, domains.length),
        numeric: ahrefsNumeric,
        numericCoveragePercent: coveragePercent(ahrefsNumeric, domains.length),
        mode: ahrefs?.mode ?? (run.configSnapshot.ahrefs?.requireAhrefs ? 'required' : 'optional'),
        summaryState: ahrefsSummaryState,
        statuses: ahrefsStatuses,
      },
    },
    geo: {
      grade: geoGrade,
      targetMarket: run.configSnapshot.research.market,
      googleHl: run.configSnapshot.research.googleHl,
      googleGl: run.configSnapshot.research.googleGl,
      detectedKeywords,
      trustworthyDetectedKeywords,
      mismatchKeywords,
      detectedLocations,
    },
    bounds: {
      organicSerpTopN: run.configSnapshot.research.topN,
      relatedExpansion: {
        enabled: expansion?.enabled ?? null,
        depth: expansion?.depth ?? null,
        maxCandidatesPerKeyword: expansion?.maxCandidatesPerKeyword ?? null,
        minOverlap: expansion?.minOverlap ?? null,
        minVolume: expansion?.minVolume ?? null,
        selectedRows: relatedKeywords.filter((row) => row.selectedForExpansion).length,
        explicitOmissionCount: null,
        omissionAccounting: 'not_persisted',
      },
    },
    warnings,
  };
}
