import {
  RunStore,
  isTerminalKeywordStatus,
  storedKeywordToRecord,
  type StoredKeyword,
  type StoredRun,
  type StoredRelatedKeyword,
  type StoredDomain,
} from '../db/store.js';
import { writeJsonAtomic, writeTextAtomic, type RunManifest, type RunState } from './run.js';
import { unlink } from 'node:fs/promises';
import { renderCsv } from '../exports/csv.js';
import type { SerpResult } from '../google/serp.js';
import {
  buildCandidates,
  resolveDrThresholds,
  SCORING_VERSION,
  type Candidate,
} from '../scoring/scoring.js';
import type { AhrefsSummary, ScoringCompleteness } from './engine.js';

// Default Ahrefs summary for runs that predate the tracker or are still running.
function emptyAhrefs(requireAhrefs: boolean): AhrefsSummary {
  return {
    mode: requireAhrefs ? 'required' : 'optional',
    state: requireAhrefs ? 'failed' : 'skipped',
    discovered: 0,
    attempted: 0,
    notAttempted: 0,
    cache: 0,
    fresh: 0,
    ok: 0,
    notFound: 0,
    error: 0,
    numericCoverage: 0,
    requireAhrefs,
  };
}

function emptyScoring(): ScoringCompleteness {
  return { status: 'degraded', numericDrCoverage: 0, missingDrDomains: 0 };
}

export function countProgress(keywords: StoredKeyword[]): {
  completed: number;
  partial: number;
  failed: number;
  errors: number;
} {
  const completed = keywords.filter((item) => item.status === 'completed').length;
  const partial = keywords.filter((item) => item.status === 'partial').length;
  const failed = keywords.filter((item) => item.status === 'failed').length;
  return { completed, partial, failed, errors: partial + failed };
}

// One definition of the truth for cache accounting. The four buckets are
// mutually exclusive and add up to the number of processed keywords: `hits`
// were served from the cache, `misses` were genuinely absent, `expired`
// entries were present but past their TTL (their own bucket, never also
// counted as misses), and `refreshed` keywords were deliberately bypassed.
// The live progress line, the manifest rollup, and keywords.json all use this
// single definition, so the numbers always agree and never double-count.
export function countCacheStats(keywords: StoredKeyword[]): {
  hits: number;
  misses: number;
  expired: number;
  refreshed: number;
} {
  const stats = { hits: 0, misses: 0, expired: 0, refreshed: 0 };
  for (const item of keywords) {
    if (item.cacheStatus === 'hit') stats.hits += 1;
    else if (item.cacheStatus === 'expired') stats.expired += 1;
    else if (item.cacheStatus === 'miss') stats.misses += 1;
    else if (item.cacheStatus === 'refreshed') stats.refreshed += 1;
  }
  return stats;
}

// Hit rate is the share of processed keywords served from the cache, rounded
// like the live CLI line. A forced refresh is a deliberate bypass (browser
// work was done), so it is never a hit; expired entries are misses by
// definition but are not subtracted from the denominator.
export function cacheHitRatePercent(hits: number, processed: number): number {
  return processed > 0 ? Math.round((hits / processed) * 100) : 0;
}

export async function writeSnapshots(
  store: RunStore,
  runId: string,
  runDirectory: string,
  state: RunState,
  ahrefs?: AhrefsSummary,
  scoringCompleteness?: ScoringCompleteness,
): Promise<void> {
  const run = store.loadRun(runId) as StoredRun;
  const keywords = store.loadKeywords(runId);
  const serpRows = store.loadSerpRows(runId);
  const progress = countProgress(keywords);
  const cacheStats = countCacheStats(keywords);

  const uniqueDomains = new Set(
    serpRows.map((row) => row.registrableDomain).filter((domain): domain is string => domain !== ''),
  );
  const completedDomains = new Set(
    serpRows
      .filter(
        (row) =>
          row.drStatus !== null &&
          row.drStatus !== 'not_attempted' &&
          row.registrableDomain !== '',
      )
      .map((row) => row.registrableDomain),
  ).size;

  const requireAhrefs = run.configSnapshot.ahrefs?.requireAhrefs ?? false;
  const ahrefsSummary = ahrefs ?? emptyAhrefs(requireAhrefs);
  const scoringSummary = scoringCompleteness ?? emptyScoring();

  const manifest: RunManifest = {
    runId,
    createdAt: run.createdAt,
    updatedAt: new Date().toISOString(),
    state,
    input: run.input,
    configSnapshot: run.configSnapshot,
    parserVersions: run.parserVersions,
    scoringVersion: SCORING_VERSION,
    pauseReason: run.pauseReason,
    ahrefs: {
      mode: ahrefsSummary.mode,
      state: ahrefsSummary.state,
      discovered: ahrefsSummary.discovered,
      attempted: ahrefsSummary.attempted,
      notAttempted: ahrefsSummary.notAttempted,
      cache: ahrefsSummary.cache,
      fresh: ahrefsSummary.fresh,
      ok: ahrefsSummary.ok,
      notFound: ahrefsSummary.notFound,
      error: ahrefsSummary.error,
      numericCoverage: ahrefsSummary.numericCoverage,
      requireAhrefs: ahrefsSummary.requireAhrefs,
    },
    scoringCompleteness: {
      status: scoringSummary.status,
      numericDrCoverage: scoringSummary.numericDrCoverage,
      missingDrDomains: scoringSummary.missingDrDomains,
    },
    progress: {
      totalKeywords: keywords.length,
      completedKeywords: progress.completed,
      partialKeywords: progress.partial,
      failedKeywords: progress.failed,
      errors: progress.errors,
      lookups: run.lookups,
      totalDomains: uniqueDomains.size,
      completedDomains,
      cache: {
        ...cacheStats,
        hitRatePercent: cacheHitRatePercent(
          cacheStats.hits,
          progress.completed + progress.partial + progress.failed,
        ),
      },
    },
  };

  // keywords.json carries the per-keyword cache decision alongside the raw
  // data, so downstream consumers can always tell cached from fresh rows.
  await writeJsonAtomic(
    `${runDirectory}/keywords.json`,
    keywords.map((keyword) => ({ ...storedKeywordToRecord(keyword), cacheStatus: keyword.cacheStatus })),
    'keywords output',
  );
  await writeJsonAtomic(`${runDirectory}/serp.json`, serpRows, 'SERP output');
  await writeTextAtomic(
    `${runDirectory}/keywords.csv`,
    renderKeywordsCsv(keywords, organicCounts(runId, store)),
    'keywords CSV',
  );
  await writeTextAtomic(`${runDirectory}/serp.csv`, renderSerpCsv(serpRows), 'SERP CSV');

  const relatedKeywords = store.loadRelatedKeywords(runId);
  const domains = store.loadDomains(runId);
  // Legacy runs may carry a configSnapshot without a scoring section; fall back
  // to the documented default DR thresholds instead of throwing.
  const candidates = buildCandidates(keywords, serpRows, resolveDrThresholds(run.configSnapshot));
  // Real related rows: count only rows with status=ok and a non-empty
  // relatedKeyword. Rows with status=error/empty/not_attempted and blank
  // keywords are excluded from the real-row count across all outputs.
  const relatedRowsCount = relatedKeywords.filter(
    (r) => r.status === 'ok' && r.relatedKeyword.trim() !== '',
  ).length;
  // Parent-keyword outcomes: group rows by parent and derive one outcome per
  // parent. A parent is 'ok' if it has at least one ok row, 'error' if it has an
  // error row (and no ok), 'empty' if all its rows are empty, 'not_attempted' if
  // it has no rows at all.
  const parentOutcomes = new Map<number, 'ok' | 'empty' | 'error'>();
  for (const row of relatedKeywords) {
    const current = parentOutcomes.get(row.parentIdx);
    if (row.status === 'ok') {
      parentOutcomes.set(row.parentIdx, 'ok');
    } else if (row.status === 'error' && current !== 'ok') {
      parentOutcomes.set(row.parentIdx, 'error');
    } else if (row.status === 'empty' && current === undefined) {
      parentOutcomes.set(row.parentIdx, 'empty');
    }
  }
  const relatedOutcomes = { ok: 0, empty: 0, error: 0, notAttempted: 0 };
  for (const outcome of parentOutcomes.values()) {
    relatedOutcomes[outcome] += 1;
  }
  const rootKeywordCount = keywords.filter((k) => !k.sources.some((s) => s.type === 'surfer_related')).length;
  relatedOutcomes.notAttempted = rootKeywordCount - parentOutcomes.size;
  await writeTextAtomic(
    `${runDirectory}/related-keywords.csv`,
    renderRelatedKeywordsCsv(relatedKeywords),
    'related keywords CSV',
  );
  await writeTextAtomic(`${runDirectory}/domains.csv`, renderDomainsCsv(domains), 'domains CSV');
  await writeTextAtomic(
    `${runDirectory}/candidates.csv`,
    renderCandidatesCsv(candidates),
    'candidates CSV',
  );
  await writeTextAtomic(
    `${runDirectory}/report.md`,
    renderReportMd({
      state,
      run,
      keywords,
      candidates,
      relatedKeywords,
      relatedRowsCount,
      relatedOutcomes,
      domains,
      progress,
      cacheStats,
      uniqueDomains: uniqueDomains.size,
      completedDomains,
      ahrefs: ahrefsSummary,
      scoringCompleteness: scoringSummary,
    }),
    'run report',
  );

  // status.json is published first. The manifest is the final artifact: if the
  // manifest write fails, status.json is removed so a terminal run state is
  // never emitted without the manifest, and the run stays resumable (not
  // falsely terminal). A run is only "complete" once both artifacts exist.
  const status = buildRunStatus(store, runId, runDirectory, state);
  await writeJsonAtomic(`${runDirectory}/status.json`, status, 'run status');

  try {
    await writeJsonAtomic(`${runDirectory}/manifest.json`, manifest, 'run manifest');
  } catch (error) {
    await unlink(`${runDirectory}/status.json`).catch(() => {});
    throw error;
  }
}

function organicCounts(runId: string, store: RunStore): Map<number, number> {
  return new Map(store.loadSerpRowCounts(runId).map((item) => [item.keywordIdx, item.count]));
}

// Operator-facing keyword export: exactly one row per canonical keyword in
// input order, with the fixed column contract of TASK-004. Missing values are
// empty cells (never "null"/"undefined"); numeric zero is a real value. The
// organic count comes from the run checkpoint, not from cache state.
export function renderKeywordsCsv(keywords: StoredKeyword[], organicCounts: Map<number, number>): string {
  const rows = [KEYWORDS_CSV_HEADERS];
  for (const keyword of keywords) {
    const organic =
      isTerminalKeywordStatus(keyword.status)
        ? String(organicCounts.get(keyword.idx) ?? 0)
        : '';
    rows.push([
      keyword.keyword,
      keyword.normalizedKeyword,
      sourceRowsValue(keyword),
      keyword.surfer === null || keyword.surfer.volume === null ? '' : String(keyword.surfer.volume),
      keyword.surfer === null || keyword.surfer.cpc === null ? '' : String(keyword.surfer.cpc),
      keyword.surfer?.market ?? '',
      keyword.google?.hl ?? '',
      keyword.google?.gl ?? '',
      keyword.google?.pageUrl ?? '',
      keyword.google?.detectedLocation ?? '',
      keyword.google === null ? '' : String(keyword.google.geoWarning),
      organic,
      keyword.status,
      keyword.error?.code ?? '',
      keyword.error?.message ?? '',
      keyword.cacheStatus ?? '',
      keyword.collectedAt ?? '',
    ]);
  }
  return renderCsv(rows);
}

// One row per stored organic result, ordered by keyword input index and then
// position; keywords without organic results contribute no rows. Preserves the
// original columns and appends the DR-enrichment fields.
export function renderSerpCsv(serpRows: SerpResult[]): string {
  const rows = [SERP_CSV_HEADERS];
  for (const row of serpRows) {
    rows.push([
      row.keyword,
      String(row.position),
      row.title,
      row.url,
      row.hostname,
      row.resultType,
      row.registrableDomain,
      row.dr === null ? '' : String(row.dr),
      row.drStatus ?? '',
    ]);
  }
  return renderCsv(rows);
}

function sourceRowsValue(keyword: StoredKeyword): string {
  const rows = Array.from(
    new Set(
      keyword.sources.flatMap((source) => {
        if (source.type === 'seed') return source.rowNumbers;
        if (source.type === 'microsoft') return [source.sourceRow];
        return source.rowNumbers ?? [];
      }),
    ),
  );
  rows.sort((a, b) => a - b);
  return rows.join('|');
}

const KEYWORDS_CSV_HEADERS = [
  'keyword',
  'normalized_keyword',
  'source_rows',
  'surfer_volume',
  'surfer_cpc',
  'surfer_market',
  'google_hl',
  'google_gl',
  'google_url',
  'detected_google_location',
  'geo_warning',
  'organic_result_count',
  'status',
  'error_code',
  'error_message',
  'cache_status',
  'collected_at',
];

const SERP_CSV_HEADERS = [
  'keyword',
  'position',
  'title',
  'url',
  'hostname',
  'result_type',
  'registrable_domain',
  'dr',
  'dr_status',
];

export const RELATED_KEYWORDS_CSV_HEADERS = [
  'parent',
  'keyword',
  'overlap',
  'volume',
  'selected',
  'status',
  'error',
];

export const DOMAINS_CSV_HEADERS = [
  'domain',
  'dr',
  'status',
  'error',
  'source',
  'fetched_at',
  'first_seen_keyword',
  'first_seen_position',
];

export const CANDIDATES_CSV_HEADERS = [
  'keyword',
  'normalized_keyword',
  'status',
  'error_code',
  'error_message',
  'organic_result_count',
  'unique_domains',
  'known_unique_domains',
  'min_dr',
  'max_dr',
  'median_dr',
  'top3_median_dr',
  'top5_median_dr',
  'very_weak_domains',
  'weak_domains',
  'strong_domains',
  'very_strong_domains',
  'missing_dr_count',
  'exact_match_domains',
  'niche_domains',
  'serp_diversity',
  'surfer_volume',
  'surfer_cpc',
  'score',
  'tier',
  'scoring_version',
  'scoring_completeness',
  'rationale',
];

export function renderRelatedKeywordsCsv(rows: StoredRelatedKeyword[]): string {
  const csv: string[][] = [RELATED_KEYWORDS_CSV_HEADERS];
  for (const row of rows) {
    csv.push([
      row.parentKeyword,
      row.relatedKeyword,
      row.overlap === null ? '' : String(row.overlap),
      row.volume === null ? '' : String(row.volume),
      row.selectedForExpansion ? 'true' : 'false',
      row.status,
      row.error ?? '',
    ]);
  }
  return renderCsv(csv);
}

export function renderDomainsCsv(rows: StoredDomain[]): string {
  const csv: string[][] = [DOMAINS_CSV_HEADERS];
  for (const row of rows) {
    csv.push([
      row.domain,
      row.dr === null ? '' : String(row.dr),
      row.status,
      row.error ?? '',
      row.source,
      row.fetchedAt ?? '',
      row.firstSeenKeyword,
      String(row.firstSeenPosition),
    ]);
  }
  return renderCsv(csv);
}

export function renderCandidatesCsv(candidates: Candidate[]): string {
  const csv: string[][] = [CANDIDATES_CSV_HEADERS];
  for (const row of candidates) {
    csv.push([
      row.keyword,
      row.normalizedKeyword,
      row.status,
      row.errorCode ?? '',
      row.errorMessage ?? '',
      String(row.organicResultCount),
      String(row.uniqueDomains),
      String(row.knownUniqueDomains),
      row.minDr === null ? '' : String(row.minDr),
      row.maxDr === null ? '' : String(row.maxDr),
      row.medianDr === null ? '' : String(row.medianDr),
      row.top3MedianDr === null ? '' : String(row.top3MedianDr),
      row.top5MedianDr === null ? '' : String(row.top5MedianDr),
      String(row.veryWeakDomainsCount),
      String(row.weakDomainsCount),
      String(row.strongDomainsCount),
      String(row.veryStrongDomainsCount),
      String(row.missingDrCount),
      String(row.exactMatchDomainCount),
      String(row.nicheDomainCount),
      String(row.serpDiversity),
      row.surferVolume === null ? '' : String(row.surferVolume),
      row.surferCpc === null ? '' : String(row.surferCpc),
      row.score === null ? '' : String(row.score),
      row.tier ?? '',
      row.scoringVersion,
      row.scoringCompleteness,
      row.rationale,
    ]);
  }
  return renderCsv(csv);
}

export type RunArtifacts = {
  manifest: string;
  keywordsJson: string;
  serpJson: string;
  keywordsCsv: string;
  serpCsv: string;
  relatedKeywordsCsv: string;
  domainsCsv: string;
  candidatesCsv: string;
  report: string;
  statusFile: string;
};

export type RunStatus = {
  status: RunState;
  runId: string;
  keywords: number;
  processedKeywords: number;
  errors: number;
  scoringVersion: string;
  candidateReport: string;
  report: string;
  statusFile: string;
  artifacts: RunArtifacts;
  counts: { domains: number; relatedKeywords: number };
  cache: {
    hits: number;
    misses: number;
    expired: number;
    refreshed: number;
    hitRatePercent: number;
  };
  lookups: number;
  ahrefs: AhrefsSummary;
  scoringCompleteness: ScoringCompleteness;
};

export function buildRunStatus(
  store: RunStore,
  runId: string,
  runDirectory: string,
  state: RunState,
  ahrefs?: AhrefsSummary,
  scoringCompleteness?: ScoringCompleteness,
): RunStatus {
  const run = store.loadRun(runId);
  const keywords = store.loadKeywords(runId);
  const progress = countProgress(keywords);
  const cacheStats = countCacheStats(keywords);
  const processed = progress.completed + progress.partial + progress.failed;
  const requireAhrefs = run?.configSnapshot.ahrefs?.requireAhrefs ?? false;
  const ahrefsSummary = ahrefs ?? emptyAhrefs(requireAhrefs);
  const scoringSummary = scoringCompleteness ?? emptyScoring();
  const artifacts: RunArtifacts = {
    manifest: `${runDirectory}/manifest.json`,
    keywordsJson: `${runDirectory}/keywords.json`,
    serpJson: `${runDirectory}/serp.json`,
    keywordsCsv: `${runDirectory}/keywords.csv`,
    serpCsv: `${runDirectory}/serp.csv`,
    relatedKeywordsCsv: `${runDirectory}/related-keywords.csv`,
    domainsCsv: `${runDirectory}/domains.csv`,
    candidatesCsv: `${runDirectory}/candidates.csv`,
    report: `${runDirectory}/report.md`,
    statusFile: `${runDirectory}/status.json`,
  };
  return {
    status: state,
    runId,
    keywords: keywords.length,
    processedKeywords: processed,
    errors: progress.errors,
    scoringVersion: SCORING_VERSION,
    candidateReport: artifacts.candidatesCsv,
    report: artifacts.report,
    statusFile: artifacts.statusFile,
    artifacts,
    counts: {
      domains: store.loadDomains(runId).length,
      relatedKeywords: store.loadRelatedKeywords(runId).filter(
        (r) => r.status === 'ok' && r.relatedKeyword.trim() !== '',
      ).length,
    },
    cache: {
      ...cacheStats,
      hitRatePercent: cacheHitRatePercent(cacheStats.hits, processed),
    },
    lookups: run?.lookups ?? 0,
    ahrefs: ahrefsSummary,
    scoringCompleteness: scoringSummary,
  };
}

export type ReportContext = {
  state: RunState;
  run: StoredRun;
  keywords: StoredKeyword[];
  candidates: Candidate[];
  relatedKeywords: StoredRelatedKeyword[];
  relatedRowsCount: number;
  relatedOutcomes: { ok: number; empty: number; error: number; notAttempted: number };
  domains: StoredDomain[];
  progress: { completed: number; partial: number; failed: number; errors: number };
  cacheStats: { hits: number; misses: number; expired: number; refreshed: number };
  uniqueDomains: number;
  completedDomains: number;
  ahrefs: AhrefsSummary;
  scoringCompleteness: ScoringCompleteness;
};

export function renderReportMd(ctx: ReportContext): string {
  const { state, run, keywords, candidates, relatedKeywords, relatedRowsCount, relatedOutcomes, domains, progress, cacheStats, ahrefs: ahrefsSummary, scoringCompleteness: scoringSummary } = ctx;
  const processed = progress.completed + progress.partial + progress.failed;
  const hitRate = cacheHitRatePercent(cacheStats.hits, processed);
  const lines: string[] = [];
  lines.push(`# Run Report — ${run.runId}`);
  lines.push('');
  lines.push(`State: **${state}**  `);
  lines.push(`Scoring version: ${SCORING_VERSION}  `);
  lines.push(`Scoring completeness: **${scoringSummary.status}**  `);
  // Deterministic timestamp from the stored run, never a freshly generated one.
  lines.push(`Created: ${run.createdAt}  Updated: ${run.updatedAt ?? run.createdAt}`);
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  lines.push(`- Input: ${run.input.kind} — ${run.input.path}`);
  lines.push(`- Keywords: ${keywords.length} (completed ${progress.completed}, partial ${progress.partial}, failed ${progress.failed}, errors ${progress.errors})`);
  lines.push(`- Processed: ${processed} / ${keywords.length}`);
  lines.push(`- Unique domains: ${ahrefsSummary.discovered} discovered, ${ahrefsSummary.attempted} attempted, ${ahrefsSummary.numericCoverage} with numeric DR`);
  lines.push(`- Related keywords: ${relatedRowsCount} real rows; parent outcomes: ok ${relatedOutcomes.ok}, empty ${relatedOutcomes.empty}, error ${relatedOutcomes.error}, not_attempted ${relatedOutcomes.notAttempted}`);
  lines.push(`- Unique domains (run-level): ${domains.length}`);
  lines.push(`- Browser lookups: ${run.lookups}`);
  lines.push(
    `- Cache: ${hitRate}% hit (${cacheStats.hits} hit / ${cacheStats.misses} miss / ${cacheStats.expired} expired / ${cacheStats.refreshed} refreshed)`,
  );
  lines.push('');

  const geoWarnings = keywords.filter((keyword) => keyword.google?.geoWarning === true);
  if (geoWarnings.length > 0) {
    lines.push('## Geo warnings');
    lines.push('');
    for (const keyword of geoWarnings) {
      lines.push(
        `- \`${keyword.keyword}\`: Surfer market ${run.configSnapshot.research.market}, Google detected "${keyword.google?.detectedLocation ?? ''}"`,
      );
    }
    lines.push('');
  }

  // Prominent warning when the Ahrefs stage was skipped/failed or numeric DR
  // coverage is incomplete. Scores based on missing DR must not be presented as
  // fully evidenced without this adjacent completeness status.
  if (ahrefsSummary.state === 'skipped' || ahrefsSummary.state === 'failed' || scoringSummary.status === 'degraded') {
    lines.push('## ⚠ Data completeness warning');
    lines.push('');
    if (ahrefsSummary.state === 'skipped') {
      lines.push('- Ahrefs DR stage was **skipped** (no AHREFS_API_KEY). Numeric scores are based on missing DR data.');
    }
    if (ahrefsSummary.state === 'failed') {
      lines.push('- Ahrefs DR stage **failed** (systemic error or missing key in required mode). Numeric scores are unreliable.');
    }
    if (scoringSummary.status === 'degraded' && ahrefsSummary.state !== 'skipped' && ahrefsSummary.state !== 'failed') {
      lines.push(`- Numeric DR coverage is incomplete (${ahrefsSummary.numericCoverage}/${ahrefsSummary.discovered} domains). ${ahrefsSummary.notAttempted} domain(s) not attempted.`);
    }
    lines.push('');
  }

  lines.push('## Top candidates');
  lines.push('');
  lines.push('| Rank | Keyword | Score | Tier | Volume | Median DR | Top3 median DR | Unique domains | SERP diversity |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const scored = candidates.filter((candidate) => candidate.score !== null);
  scored.slice(0, 20).forEach((candidate, index) => {
    lines.push(
      `| ${index + 1} | ${candidate.keyword} | ${candidate.score} | ${candidate.tier} | ${candidate.surferVolume ?? '-'} | ${candidate.medianDr ?? '-'} | ${candidate.top3MedianDr ?? '-'} | ${candidate.uniqueDomains} | ${candidate.serpDiversity} |`,
    );
  });
  if (scored.length === 0) lines.push('_No scored candidates._');
  lines.push('');

  const incomplete = keywords.filter(
    (keyword) => keyword.status === 'failed' || keyword.status === 'partial',
  );
  if (incomplete.length > 0) {
    lines.push('## Failed / incomplete keywords');
    lines.push('');
    lines.push('| Keyword | Status | Error code | Error message |');
    lines.push('| --- | --- | --- | --- |');
    for (const keyword of incomplete) {
      lines.push(
        `| ${keyword.keyword} | ${keyword.status} | ${keyword.error?.code ?? ''} | ${keyword.error?.message ?? ''} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Cache / Ahrefs / parser statistics');
  lines.push('');
  lines.push(`- Parser versions: Surfer ${run.parserVersions.surfer}, Google ${run.parserVersions.google}`);
  lines.push(
    `- Ahrefs DR: ${ahrefsSummary.discovered} discovered, ${ahrefsSummary.attempted} attempted, ${ahrefsSummary.notAttempted} not_attempted (mode: ${ahrefsSummary.mode}, state: ${ahrefsSummary.state})`,
  );
  lines.push(
    `  - status: ok ${ahrefsSummary.ok}, not_found ${ahrefsSummary.notFound}, error ${ahrefsSummary.error}; numeric DR coverage ${ahrefsSummary.numericCoverage}/${ahrefsSummary.discovered}`,
  );
  lines.push(
    `  - source: cache ${ahrefsSummary.cache}, fresh ${ahrefsSummary.fresh}`,
  );
  lines.push(
    `- Scoring completeness: ${scoringSummary.status} (numeric DR coverage ${scoringSummary.numericDrCoverage}, missing DR domains ${scoringSummary.missingDrDomains})`,
  );
  lines.push(
    `- Cache buckets: ${cacheStats.hits} hit / ${cacheStats.misses} miss / ${cacheStats.expired} expired / ${cacheStats.refreshed} refreshed (${hitRate}% hit rate)`,
  );
  lines.push('');

  const drErrorDomains = domains.filter((d) => d.status === 'error');
  const noVolume = keywords.filter((k) => k.surfer?.volume === null && k.status !== 'failed').length;
  lines.push('## Next manual checks');
  lines.push('');
  if (scored.length > 0) {
    lines.push(`- Inspect tier A/B candidates first (top ${Math.min(scored.length, 20)} listed above).`);
  } else {
    lines.push('- No scored candidates were produced; verify Surfer volume and SERP collection.');
  }
  if (progress.failed > 0) lines.push(`- Resolve ${progress.failed} failed keyword(s) (see Failed / incomplete above).`);
  if (drErrorDomains.length > 0) lines.push(`- Re-run Ahrefs DR for ${drErrorDomains.length} domain(s) that returned an error.`);
  if (geoWarnings.length > 0) lines.push(`- Verify ${geoWarnings.length} geo-mismatched keyword(s); detected location may not match the target market.`);
  if (noVolume > 0) lines.push(`- ${noVolume} completed keyword(s) have no Surfer volume; demand score is zero.`);
  lines.push('');

  return lines.join('\n');
}
