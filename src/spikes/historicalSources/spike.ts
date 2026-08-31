import { parse } from 'csv-parse/sync';
import { renderCsv } from '../../exports/csv.js';
import type { FirstSeenClient, FirstSeenResult } from '../../firstseen/types.js';
import {
  COMMON_CRAWL_SOURCE,
  selectCommonCrawlCollections,
  type CommonCrawlCollection,
  type CommonCrawlCollectionMode,
  type CommonCrawlDomainResult,
  type HistoricalSourceStatus,
} from './commonCrawl.js';

export type HistoricalDomainObservation = {
  domain: string;
  dataset: string;
  sourceRunId: string;
  sourceEnrichmentId: string;
  registrationDate: string | null;
  registrationStatus: string;
  sourceKeywords: string[];
  sourceRanks: string[];
  observedAt: string | null;
};

export type HistoricalDomainGroup = {
  domain: string;
  datasets: string[];
  sourceRunIds: string[];
  sourceEnrichmentIds: string[];
  sourceKeywords: string[];
  sourceRanks: string[];
  observations: HistoricalDomainObservation[];
};

export type TimedWaybackResult = FirstSeenResult & { latencyMs: number };

export type HistoricalDomainEvidence = {
  domain: string;
  datasets: string[];
  sourceRunIds: string[];
  sourceEnrichmentIds: string[];
  sourceKeywords: string[];
  sourceRanks: string[];
  registrationDate: string | null;
  registrationStatus: string;
  registrationConflict: boolean;
  commonCrawl: CommonCrawlDomainResult;
  wayback: TimedWaybackResult;
  commonCrawlBeforeRegistration: boolean | null;
  waybackBeforeRegistration: boolean | null;
  commonCrawlVsRegistrationDays: number | null;
  waybackVsRegistrationDays: number | null;
  archiveDeltaDays: number | null;
};

export type HistoricalProviderSummary = {
  denominator: number;
  ok: number;
  notFound: number;
  unavailable: number;
  notAttempted: number;
  error: number;
  coveragePercent: number | null;
  requestCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
};

export type HistoricalSpikeResult = {
  version: '1.0.0';
  generatedAt: string;
  input: {
    observationRows: number;
    uniqueDomains: number;
    datasets: string[];
  };
  commonCrawlScope: {
    mode: CommonCrawlCollectionMode;
    collectionsAvailable: number;
    collectionsSelected: number;
    selectedCollectionIds: string[];
    collectionListError: string | null;
    plannedCollectionChecksUpperBound: number;
    requestBudget: number;
    largeScanExplicitlyAllowed: boolean;
    semanticNote: string;
  };
  providerSummary: {
    registrationContext: {
      denominator: number;
      observed: number;
      unsupportedOrMissing: number;
      error: number;
      conflict: number;
      coveragePercent: number | null;
    };
    commonCrawl: HistoricalProviderSummary;
    wayback: HistoricalProviderSummary;
  };
  comparison: {
    bothArchiveSourcesObserved: number;
    commonCrawlOnlyObserved: number;
    waybackOnlyObserved: number;
    neitherArchiveSourceObserved: number;
    commonCrawlEarlier: number;
    waybackEarlier: number;
    sameTimestamp: number;
    commonCrawlBeforeRegistration: number;
    waybackBeforeRegistration: number;
  };
  domains: HistoricalDomainEvidence[];
  decisionGate: {
    status: 'pending_human_review';
    allowedDecisions: ['PROMOTE common_crawl', 'DEFER historical provider'];
    note: string;
  };
};

export type HistoricalSpikeDeps = {
  commonCrawl: {
    loadCollections: () => Promise<CommonCrawlCollection[]>;
    lookupDomain: (domain: string, collections: CommonCrawlCollection[]) => Promise<CommonCrawlDomainResult>;
  };
  wayback: FirstSeenClient;
  now?: () => number;
  onProgress?: (progress: {
    completed: number;
    total: number;
    domain: string;
    commonCrawlStatus: HistoricalSourceStatus;
    waybackStatus: FirstSeenResult['status'];
  }) => void;
};

export type HistoricalSpikeOptions = {
  rows: HistoricalDomainObservation[];
  collectionMode: CommonCrawlCollectionMode;
  recentMonths: number;
  maxCollections: number | null;
  requestBudget: number;
  allowLargeScan: boolean;
};

const REQUIRED_COLUMNS = [
  'domain', 'dataset', 'source_run_id', 'source_enrichment_id',
  'registration_date', 'registration_status', 'source_keywords', 'source_ranks', 'observed_at',
] as const;

function splitList(value: string, delimiter: ',' | '|'): string[] {
  return Array.from(new Set(value.split(delimiter).map((item) => item.trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
}

function validateDomain(raw: string, rowNumber: number): string {
  const domain = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || domain.startsWith('.') || domain.endsWith('.') || !domain.includes('.')) {
    throw new Error(`Historical-source fixture row ${rowNumber}: invalid domain "${raw}".`);
  }
  if (/[^a-z0-9._-]/.test(domain) || /[/:@?#\s]/.test(domain)) {
    throw new Error(`Historical-source fixture row ${rowNumber}: invalid hostname-only domain "${raw}".`);
  }
  return domain;
}

function nullableIso(raw: string, field: string, rowNumber: number): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Historical-source fixture row ${rowNumber}: ${field} is not a valid date: "${raw}".`);
  }
  return value;
}

export function parseHistoricalDomainFixture(content: string): HistoricalDomainObservation[] {
  const records = parse(content, { columns: true, skip_empty_lines: true, bom: true, trim: false }) as Array<Record<string, string>>;
  if (records.length === 0) throw new Error('Historical-source fixture is empty.');

  const columns = new Set(Object.keys(records[0] ?? {}));
  for (const required of REQUIRED_COLUMNS) {
    if (!columns.has(required)) throw new Error(`Historical-source fixture is missing required column "${required}".`);
  }

  return records.map((record, index) => {
    const rowNumber = index + 2;
    const dataset = String(record.dataset ?? '').trim();
    const sourceRunId = String(record.source_run_id ?? '').trim();
    const sourceEnrichmentId = String(record.source_enrichment_id ?? '').trim();
    const registrationStatus = String(record.registration_status ?? '').trim();
    if (!dataset || !sourceRunId || !sourceEnrichmentId || !registrationStatus) {
      throw new Error(`Historical-source fixture row ${rowNumber}: provenance/status fields must not be blank.`);
    }
    return {
      domain: validateDomain(String(record.domain ?? ''), rowNumber),
      dataset,
      sourceRunId,
      sourceEnrichmentId,
      registrationDate: nullableIso(String(record.registration_date ?? ''), 'registration_date', rowNumber),
      registrationStatus,
      sourceKeywords: splitList(String(record.source_keywords ?? ''), ','),
      sourceRanks: splitList(String(record.source_ranks ?? ''), '|'),
      observedAt: nullableIso(String(record.observed_at ?? ''), 'observed_at', rowNumber),
    };
  });
}

export function groupHistoricalDomains(rows: HistoricalDomainObservation[]): HistoricalDomainGroup[] {
  const byDomain = new Map<string, HistoricalDomainObservation[]>();
  for (const row of rows) byDomain.set(row.domain, [...(byDomain.get(row.domain) ?? []), row]);

  return [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([domain, observations]) => ({
    domain,
    datasets: Array.from(new Set(observations.map((row) => row.dataset))).sort(),
    sourceRunIds: Array.from(new Set(observations.map((row) => row.sourceRunId))).sort(),
    sourceEnrichmentIds: Array.from(new Set(observations.map((row) => row.sourceEnrichmentId))).sort(),
    sourceKeywords: Array.from(new Set(observations.flatMap((row) => row.sourceKeywords))).sort(),
    sourceRanks: Array.from(new Set(observations.flatMap((row) => row.sourceRanks))).sort(),
    observations,
  }));
}

function percent(observed: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((observed / denominator) * 1000) / 10;
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? null;
}

function summarizeHistoricalSource(
  statuses: HistoricalSourceStatus[],
  requestCounts: number[],
  latencyValues: number[],
): HistoricalProviderSummary {
  const counts: Record<HistoricalSourceStatus, number> = {
    ok: 0,
    not_found: 0,
    unavailable: 0,
    not_attempted: 0,
    error: 0,
  };
  for (const status of statuses) counts[status] += 1;
  return {
    denominator: statuses.length,
    ok: counts.ok,
    notFound: counts.not_found,
    unavailable: counts.unavailable,
    notAttempted: counts.not_attempted,
    error: counts.error,
    coveragePercent: percent(counts.ok, statuses.length),
    requestCount: requestCounts.reduce((sum, value) => sum + value, 0),
    p50LatencyMs: percentile(latencyValues, 0.5),
    p95LatencyMs: percentile(latencyValues, 0.95),
  };
}

function registrationFor(group: HistoricalDomainGroup): { date: string | null; status: string; conflict: boolean } {
  const dates = Array.from(new Set(group.observations
    .filter((item) => item.registrationStatus === 'ok' && item.registrationDate !== null)
    .map((item) => item.registrationDate as string)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const statuses = Array.from(new Set(group.observations.map((item) => item.registrationStatus)));
  return {
    date: dates.length > 1 ? null : dates[0] ?? null,
    status: dates.length > 0 ? 'ok' : statuses.length === 1 ? (statuses[0] ?? 'unknown') : 'mixed',
    conflict: dates.length > 1,
  };
}

function daysBetween(later: string | null, earlier: string | null): number | null {
  if (!later || !earlier) return null;
  const laterMs = Date.parse(later);
  const earlierMs = Date.parse(earlier);
  if (Number.isNaN(laterMs) || Number.isNaN(earlierMs)) return null;
  return Math.round(((laterMs - earlierMs) / 86_400_000) * 10) / 10;
}

function beforeRegistration(archiveDate: string | null, registrationDate: string | null): boolean | null {
  const gap = daysBetween(archiveDate, registrationDate);
  return gap === null ? null : gap < 0;
}

function unavailableCommonCrawl(domain: string, reason: string): CommonCrawlDomainResult {
  return {
    domain,
    status: 'unavailable',
    earliestSampledCaptureAt: null,
    earliestSampledCaptureUrl: null,
    earliestMatchedCollectionId: null,
    earliestMatchedCollectionFrom: null,
    earliestMatchedCollectionTo: null,
    historyCompleteForSelectedCollections: false,
    selectedCollectionCount: 0,
    checkedCollectionCount: 0,
    requestCount: 0,
    requestLatenciesMs: [],
    attempts: [],
    source: COMMON_CRAWL_SOURCE,
    sourceReason: reason,
  };
}

function failedWayback(domain: string, error: unknown, nowMs: number, latencyMs: number): TimedWaybackResult {
  return {
    domain,
    firstSeenDate: null,
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
    source: 'wayback',
    sourceReason: null,
    fetchedAt: new Date(nowMs).toISOString(),
    requestCount: 0,
    httpStatus: null,
    latencyMs,
  };
}

export async function runHistoricalSourceSpike(
  options: HistoricalSpikeOptions,
  deps: HistoricalSpikeDeps,
): Promise<HistoricalSpikeResult> {
  const now = deps.now ?? Date.now;
  const groups = groupHistoricalDomains(options.rows);
  if (groups.length === 0) throw new Error('Historical-source spike has no domains to inspect.');

  let allCollections: CommonCrawlCollection[] = [];
  let selectedCollections: CommonCrawlCollection[] = [];
  let collectionListError: string | null = null;
  try {
    allCollections = await deps.commonCrawl.loadCollections();
    selectedCollections = selectCommonCrawlCollections(allCollections, options.collectionMode, {
      nowMs: now(),
      recentMonths: options.recentMonths,
      maxCollections: options.maxCollections,
    });
  } catch (error) {
    collectionListError = error instanceof Error ? error.message : String(error);
  }

  const plannedCollectionChecksUpperBound = groups.length * selectedCollections.length;
  if (!options.allowLargeScan && plannedCollectionChecksUpperBound > options.requestBudget) {
    throw new Error(
      `Historical-source Common Crawl plan requires up to ${plannedCollectionChecksUpperBound} collection checks, above request budget ${options.requestBudget}. Reduce domains/collections or explicitly allow a larger scan.`,
    );
  }

  const domains: HistoricalDomainEvidence[] = [];
  const waybackLatencies: number[] = [];
  for (const group of groups) {
    const commonCrawl = collectionListError
      ? unavailableCommonCrawl(group.domain, `Common Crawl collection list unavailable: ${collectionListError}`)
      : await deps.commonCrawl.lookupDomain(group.domain, selectedCollections);

    const startedAt = now();
    let wayback: TimedWaybackResult;
    try {
      const raw = await deps.wayback(group.domain);
      const latencyMs = Math.max(0, now() - startedAt);
      wayback = { ...raw, latencyMs };
      if (raw.requestCount > 0) waybackLatencies.push(latencyMs);
    } catch (error) {
      const endedAt = now();
      wayback = failedWayback(group.domain, error, endedAt, Math.max(0, endedAt - startedAt));
    }

    const registration = registrationFor(group);
    const commonCrawlDate = commonCrawl.earliestSampledCaptureAt;
    const waybackDate = wayback.firstSeenDate;
    domains.push({
      domain: group.domain,
      datasets: group.datasets,
      sourceRunIds: group.sourceRunIds,
      sourceEnrichmentIds: group.sourceEnrichmentIds,
      sourceKeywords: group.sourceKeywords,
      sourceRanks: group.sourceRanks,
      registrationDate: registration.date,
      registrationStatus: registration.status,
      registrationConflict: registration.conflict,
      commonCrawl,
      wayback,
      commonCrawlBeforeRegistration: beforeRegistration(commonCrawlDate, registration.date),
      waybackBeforeRegistration: beforeRegistration(waybackDate, registration.date),
      commonCrawlVsRegistrationDays: daysBetween(commonCrawlDate, registration.date),
      waybackVsRegistrationDays: daysBetween(waybackDate, registration.date),
      archiveDeltaDays: daysBetween(commonCrawlDate, waybackDate),
    });

    deps.onProgress?.({
      completed: domains.length,
      total: groups.length,
      domain: group.domain,
      commonCrawlStatus: commonCrawl.status,
      waybackStatus: wayback.status,
    });
  }

  const registrationObserved = domains.filter((item) => item.registrationStatus === 'ok' && item.registrationDate !== null).length;
  const registrationErrors = domains.filter((item) => item.registrationStatus === 'error').length;
  const commonCrawlSummary = summarizeHistoricalSource(
    domains.map((item) => item.commonCrawl.status),
    domains.map((item) => item.commonCrawl.requestCount),
    domains.flatMap((item) => item.commonCrawl.requestLatenciesMs),
  );
  const waybackSummary = summarizeHistoricalSource(
    domains.map((item) => item.wayback.status),
    domains.map((item) => item.wayback.requestCount),
    waybackLatencies,
  );
  const both = domains.filter((item) => item.commonCrawl.status === 'ok' && item.wayback.status === 'ok');

  return {
    version: '1.0.0',
    generatedAt: new Date(now()).toISOString(),
    input: {
      observationRows: options.rows.length,
      uniqueDomains: groups.length,
      datasets: Array.from(new Set(options.rows.map((row) => row.dataset))).sort(),
    },
    commonCrawlScope: {
      mode: options.collectionMode,
      collectionsAvailable: allCollections.length,
      collectionsSelected: selectedCollections.length,
      selectedCollectionIds: selectedCollections.map((item) => item.id),
      collectionListError,
      plannedCollectionChecksUpperBound,
      requestBudget: options.requestBudget,
      largeScanExplicitlyAllowed: options.allowLargeScan,
      semanticNote: options.collectionMode === 'all'
        ? 'All selected per-crawl CDXJ indexes are checked oldest-first. limit=1 proves presence in the earliest matching crawl but not the first capture timestamp inside that crawl.'
        : options.collectionMode === 'latest'
          ? 'Only the latest crawl is checked. This measures current Common Crawl coverage, not historical first-seen.'
          : 'Annual mode samples the oldest crawl of each year plus recent crawls. earliestSampledCaptureAt is bounded sampled evidence, not an exact first-ever Common Crawl timestamp.',
    },
    providerSummary: {
      registrationContext: {
        denominator: domains.length,
        observed: registrationObserved,
        unsupportedOrMissing: domains.length - registrationObserved - registrationErrors,
        error: registrationErrors,
        conflict: domains.filter((item) => item.registrationConflict).length,
        coveragePercent: percent(registrationObserved, domains.length),
      },
      commonCrawl: commonCrawlSummary,
      wayback: waybackSummary,
    },
    comparison: {
      bothArchiveSourcesObserved: both.length,
      commonCrawlOnlyObserved: domains.filter((item) => item.commonCrawl.status === 'ok' && item.wayback.status !== 'ok').length,
      waybackOnlyObserved: domains.filter((item) => item.commonCrawl.status !== 'ok' && item.wayback.status === 'ok').length,
      neitherArchiveSourceObserved: domains.filter((item) => item.commonCrawl.status !== 'ok' && item.wayback.status !== 'ok').length,
      commonCrawlEarlier: both.filter((item) => item.archiveDeltaDays !== null && item.archiveDeltaDays < 0).length,
      waybackEarlier: both.filter((item) => item.archiveDeltaDays !== null && item.archiveDeltaDays > 0).length,
      sameTimestamp: both.filter((item) => item.archiveDeltaDays === 0).length,
      commonCrawlBeforeRegistration: domains.filter((item) => item.commonCrawlBeforeRegistration === true).length,
      waybackBeforeRegistration: domains.filter((item) => item.waybackBeforeRegistration === true).length,
    },
    domains,
    decisionGate: {
      status: 'pending_human_review',
      allowedDecisions: ['PROMOTE common_crawl', 'DEFER historical provider'],
      note: 'The spike packages evidence only. Promotion requires review of live coverage, failures, latency/request cost, date anomalies, and incremental value beyond persisted RDAP/Wayback context.',
    },
  };
}

function cell(value: string | number | boolean | null): string {
  return value === null ? '' : String(value);
}

export function renderHistoricalSpikeCsv(result: HistoricalSpikeResult): string {
  const rows: string[][] = [[
    'domain', 'datasets', 'source_run_ids', 'source_enrichment_ids',
    'registration_date', 'registration_status', 'registration_conflict',
    'common_crawl_status', 'common_crawl_earliest_sampled_capture_at',
    'common_crawl_earliest_matched_collection', 'common_crawl_history_complete_for_selected_collections',
    'common_crawl_request_count', 'wayback_status', 'wayback_first_seen_date',
    'wayback_request_count', 'wayback_latency_ms', 'common_crawl_vs_registration_days',
    'wayback_vs_registration_days', 'common_crawl_vs_wayback_days',
    'common_crawl_before_registration', 'wayback_before_registration', 'source_keywords', 'source_ranks',
  ]];

  for (const item of result.domains) {
    rows.push([
      item.domain,
      item.datasets.join('|'),
      item.sourceRunIds.join('|'),
      item.sourceEnrichmentIds.join('|'),
      cell(item.registrationDate),
      item.registrationStatus,
      cell(item.registrationConflict),
      item.commonCrawl.status,
      cell(item.commonCrawl.earliestSampledCaptureAt),
      cell(item.commonCrawl.earliestMatchedCollectionId),
      cell(item.commonCrawl.historyCompleteForSelectedCollections),
      cell(item.commonCrawl.requestCount),
      item.wayback.status,
      cell(item.wayback.firstSeenDate),
      cell(item.wayback.requestCount),
      cell(item.wayback.latencyMs),
      cell(item.commonCrawlVsRegistrationDays),
      cell(item.waybackVsRegistrationDays),
      cell(item.archiveDeltaDays),
      cell(item.commonCrawlBeforeRegistration),
      cell(item.waybackBeforeRegistration),
      item.sourceKeywords.join('|'),
      item.sourceRanks.join('|'),
    ]);
  }
  return renderCsv(rows);
}

function percentageCell(value: number | null): string {
  return value === null ? 'n/a' : `${value}%`;
}

function summaryRow(name: string, summary: HistoricalProviderSummary): string {
  return `| ${name} | ${summary.ok}/${summary.denominator} | ${percentageCell(summary.coveragePercent)} | ${summary.notFound} | ${summary.unavailable} | ${summary.notAttempted} | ${summary.error} | ${summary.requestCount} | ${summary.p50LatencyMs ?? 'n/a'} | ${summary.p95LatencyMs ?? 'n/a'} |`;
}

export function renderHistoricalSpikeMarkdown(result: HistoricalSpikeResult): string {
  const rdap = result.providerSummary.registrationContext;
  return [
    '# V2.2 Historical Source Spike',
    '',
    `Generated: ${result.generatedAt}`,
    '',
    '## Input',
    '',
    `- ${result.input.observationRows} persisted observation rows`,
    `- ${result.input.uniqueDomains} unique real observed domains`,
    `- datasets: ${result.input.datasets.join(', ')}`,
    `- persisted RDAP registration coverage: ${rdap.observed}/${rdap.denominator} (${percentageCell(rdap.coveragePercent)})`,
    '',
    '## Common Crawl scan scope',
    '',
    `- mode: ${result.commonCrawlScope.mode}`,
    `- collection indexes available: ${result.commonCrawlScope.collectionsAvailable}`,
    `- collection indexes selected: ${result.commonCrawlScope.collectionsSelected}`,
    `- planned collection checks upper bound: ${result.commonCrawlScope.plannedCollectionChecksUpperBound}`,
    `- collection list error: ${result.commonCrawlScope.collectionListError ?? 'none'}`,
    '',
    result.commonCrawlScope.semanticNote,
    '',
    '## Live archive-source results',
    '',
    '| Source | Observed | Coverage | Not found | Unavailable | Not attempted | Error | Requests | p50 latency ms | p95 latency ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    summaryRow('Common Crawl', result.providerSummary.commonCrawl),
    summaryRow('Wayback', result.providerSummary.wayback),
    '',
    'Common Crawl latency is measured per actual domain CDX request; the one-time collection-list request is not included. Wayback latency is measured per domain call because the existing provider encapsulates its retries.',
    '',
    '## Cross-source observations',
    '',
    `- both archive sources observed: ${result.comparison.bothArchiveSourcesObserved}`,
    `- Common Crawl only observed: ${result.comparison.commonCrawlOnlyObserved}`,
    `- Wayback only observed: ${result.comparison.waybackOnlyObserved}`,
    `- neither archive source observed: ${result.comparison.neitherArchiveSourceObserved}`,
    `- Common Crawl sampled timestamp earlier where both exist: ${result.comparison.commonCrawlEarlier}`,
    `- Wayback timestamp earlier where both exist: ${result.comparison.waybackEarlier}`,
    `- exact same timestamp where both exist: ${result.comparison.sameTimestamp}`,
    `- Common Crawl observation before persisted registration date: ${result.comparison.commonCrawlBeforeRegistration}`,
    `- Wayback observation before persisted registration date: ${result.comparison.waybackBeforeRegistration}`,
    '',
    '## Truth constraints',
    '',
    '- Archive/index presence is not domain registration and is not product-launch time.',
    '- A first returned capture is not proof of first existence.',
    '- Common Crawl has separate per-crawl CDXJ indexes; non-`all` modes intentionally provide bounded sampled history.',
    '- `not_found` means no capture was observed in the checked scope; it is not proof that the domain was absent from the web.',
    '- `unavailable`, `not_attempted`, and `error` remain separate from `not_found`.',
    '- Persisted RDAP registration context is comparison evidence; it never back-fills archive first-seen.',
    '',
    '## Decision gate',
    '',
    '**PENDING HUMAN REVIEW**',
    '',
    'Allowed PR-01 outcomes:',
    '',
    '```text',
    'PROMOTE common_crawl',
    'DEFER historical provider',
    '```',
    '',
    result.decisionGate.note,
    '',
  ].join('\n');
}
