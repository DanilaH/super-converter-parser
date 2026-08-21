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
import { renderCsv } from '../exports/csv.js';
import type { SerpResult } from '../google/serp.js';
import {
  buildCandidates,
  resolveDrThresholds,
  SCORING_VERSION,
  type Candidate,
} from '../scoring/scoring.js';

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
      domains,
      progress,
      cacheStats,
      uniqueDomains: uniqueDomains.size,
      completedDomains,
    }),
    'run report',
  );

  // The manifest is published before status.json. status.json is the final
  // artifact written: if publishing fails mid-way (including the manifest), a
  // terminal status.json is never emitted, so the run is not mistaken for
  // complete and stays resumable.
  await writeJsonAtomic(`${runDirectory}/manifest.json`, manifest, 'run manifest');

  const status = buildRunStatus(store, runId, runDirectory, state);
  await writeJsonAtomic(`${runDirectory}/status.json`, status, 'run status');
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
};

export function buildRunStatus(
  store: RunStore,
  runId: string,
  runDirectory: string,
  state: RunState,
): RunStatus {
  const run = store.loadRun(runId);
  const keywords = store.loadKeywords(runId);
  const progress = countProgress(keywords);
  const cacheStats = countCacheStats(keywords);
  const processed = progress.completed + progress.partial + progress.failed;
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
      relatedKeywords: store.loadRelatedKeywords(runId).length,
    },
    cache: {
      ...cacheStats,
      hitRatePercent: cacheHitRatePercent(cacheStats.hits, processed),
    },
    lookups: run?.lookups ?? 0,
  };
}

export type ReportContext = {
  state: RunState;
  run: StoredRun;
  keywords: StoredKeyword[];
  candidates: Candidate[];
  relatedKeywords: StoredRelatedKeyword[];
  domains: StoredDomain[];
  progress: { completed: number; partial: number; failed: number; errors: number };
  cacheStats: { hits: number; misses: number; expired: number; refreshed: number };
  uniqueDomains: number;
  completedDomains: number;
};

export function renderReportMd(ctx: ReportContext): string {
  const { state, run, keywords, candidates, relatedKeywords, domains, progress, cacheStats } = ctx;
  const processed = progress.completed + progress.partial + progress.failed;
  const hitRate = cacheHitRatePercent(cacheStats.hits, processed);
  const lines: string[] = [];
  lines.push(`# Run Report — ${run.runId}`);
  lines.push('');
  lines.push(`State: **${state}**  `);
  lines.push(`Scoring version: ${SCORING_VERSION}  `);
  // Deterministic timestamp from the stored run, never a freshly generated one.
  lines.push(`Created: ${run.createdAt}  Updated: ${run.updatedAt ?? run.createdAt}`);
  lines.push('');
  lines.push('## Overview');
  lines.push('');
  lines.push(`- Input: ${run.input.kind} — ${run.input.path}`);
  lines.push(`- Keywords: ${keywords.length} (completed ${progress.completed}, partial ${progress.partial}, failed ${progress.failed}, errors ${progress.errors})`);
  lines.push(`- Processed: ${processed} / ${keywords.length}`);
  lines.push(`- Unique domains: ${ctx.uniqueDomains} (DR resolved: ${ctx.completedDomains})`);
  lines.push(`- Related keywords observed: ${relatedKeywords.length}`);
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
    `- Ahrefs DR: ${domains.length} unique domains resolved (ok ${domains.filter((d) => d.status === 'ok').length}, not_found ${domains.filter((d) => d.status === 'not_found').length}, error ${domains.filter((d) => d.status === 'error').length}); from cache ${domains.filter((d) => d.source === 'cache').length}, fresh ${domains.filter((d) => d.source === 'fresh').length}`,
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
