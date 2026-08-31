import {
  HISTORICAL_PRESENCE_QUERY_VERSION,
  HISTORICAL_PRESENCE_SOURCE_COMMON_CRAWL,
  type HistoricalPresenceClient,
  type HistoricalPresenceCollectionMode,
  type HistoricalPresenceConfigSnapshot,
  type HistoricalPresenceResult,
  type HistoricalPresenceStatus,
} from './types.js';

export const COMMON_CRAWL_COLLECTIONS_URL = 'https://index.commoncrawl.org/collinfo.json';
export const COMMON_CRAWL_USER_AGENT = 'super-converter-parser/0.0.1 (+https://github.com/DanilaH/super-converter-parser)';
const COMMON_CRAWL_ORIGIN = 'https://index.commoncrawl.org';
const RETRY_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 509]);
const CIRCUIT_OPEN_HTTP_STATUSES = new Set([403, 451]);

export type CommonCrawlCollection = {
  id: string;
  name: string;
  cdxApi: string;
  from: string | null;
  to: string | null;
};

type CommonCrawlCapture = {
  timestamp: string;
  url: string;
  status: string | null;
};

type CommonCrawlAttempt = {
  collection: CommonCrawlCollection;
  status: HistoricalPresenceStatus;
  capture: CommonCrawlCapture | null;
  httpStatus: number | null;
  requestCount: number;
  error: string | null;
  sourceReason: string | null;
};

type CommonCrawlRuntimeConfig = HistoricalPresenceConfigSnapshot & {
  collectionsUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeCollectionIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim();
  const candidate = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const timestamp = Date.parse(candidate);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString().replace('.000Z', 'Z');
}

function assertCommonCrawlUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid Common Crawl URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== COMMON_CRAWL_ORIGIN) {
    throw new Error(`Refusing non-Common-Crawl URL: ${raw}`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export function parseCommonCrawlCollections(value: unknown): CommonCrawlCollection[] {
  if (!Array.isArray(value)) throw new Error('Common Crawl collection list is not an array.');
  const collections: CommonCrawlCollection[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const cdxApi = typeof record['cdx-api'] === 'string' ? record['cdx-api'].trim() : '';
    if (!id.startsWith('CC-MAIN-') || !cdxApi) continue;
    collections.push({
      id,
      name: name || id,
      cdxApi: assertCommonCrawlUrl(cdxApi),
      from: normalizeCollectionIso(record.from),
      to: normalizeCollectionIso(record.to),
    });
  }
  if (collections.length === 0) throw new Error('Common Crawl collection list contains no usable CC-MAIN collections.');
  return collections.sort(compareCollections);
}

function compareCollections(a: CommonCrawlCollection, b: CommonCrawlCollection): number {
  const aTime = a.from ? Date.parse(a.from) : Number.POSITIVE_INFINITY;
  const bTime = b.from ? Date.parse(b.from) : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return a.id.localeCompare(b.id);
}

function collectionYear(collection: CommonCrawlCollection): number | null {
  const value = collection.from ?? collection.to;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear();
}

function monthCutoff(nowMs: number, months: number): number {
  const date = new Date(nowMs);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.getTime();
}

export function selectCommonCrawlCollections(
  collections: CommonCrawlCollection[],
  mode: HistoricalPresenceCollectionMode,
  options: { nowMs: number; recentMonths: number; maxCollections: number },
): CommonCrawlCollection[] {
  const sorted = [...collections].sort(compareCollections);
  if (mode === 'latest') return sorted.length === 0 ? [] : [sorted[sorted.length - 1] as CommonCrawlCollection];

  const oldestByYear = new Map<number, CommonCrawlCollection>();
  for (const collection of sorted) {
    const year = collectionYear(collection);
    if (year !== null && !oldestByYear.has(year)) oldestByYear.set(year, collection);
  }

  const selected = new Map<string, CommonCrawlCollection>();
  for (const collection of oldestByYear.values()) selected.set(collection.id, collection);
  const cutoff = monthCutoff(options.nowMs, options.recentMonths);
  for (const collection of sorted) {
    const boundary = collection.to ?? collection.from;
    if (boundary && Date.parse(boundary) >= cutoff) selected.set(collection.id, collection);
  }

  let result = [...selected.values()].sort(compareCollections);
  if (result.length <= options.maxCollections) return result;

  const mandatory = result.filter((collection) => oldestByYear.get(collectionYear(collection) ?? -1) === collection);
  if (mandatory.length >= options.maxCollections) return mandatory.slice(0, options.maxCollections);

  const mandatoryIds = new Set(mandatory.map((collection) => collection.id));
  const recentExtras = result
    .filter((collection) => !mandatoryIds.has(collection.id))
    .slice(-(options.maxCollections - mandatory.length));
  result = [...mandatory, ...recentExtras].sort(compareCollections);
  return result;
}

export function buildCommonCrawlQuery(cdxApi: string, domain: string): string {
  const url = new URL(assertCommonCrawlUrl(cdxApi));
  url.search = '';
  url.searchParams.set('url', domain);
  url.searchParams.set('output', 'json');
  url.searchParams.set('matchType', 'domain');
  url.searchParams.set('limit', '1');
  return url.toString();
}

function parseCompactTimestamp(value: string): string | null {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const padded = digits.padEnd(14, '0').slice(0, 14);
  const year = Number(padded.slice(0, 4));
  const month = Number(padded.slice(4, 6));
  const day = Number(padded.slice(6, 8));
  const hour = Number(padded.slice(8, 10));
  const minute = Number(padded.slice(10, 12));
  const second = Number(padded.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) return null;
  return date.toISOString().replace('.000Z', 'Z');
}

export function parseCommonCrawlCaptureLines(raw: string): CommonCrawlCapture | null {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const captures: CommonCrawlCapture[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error('Malformed Common Crawl CDX JSON line.');
    }
    const record = asRecord(value);
    if (!record) throw new Error('Malformed Common Crawl CDX record.');
    const timestamp = parseCompactTimestamp(typeof record.timestamp === 'string' ? record.timestamp : '');
    const url = typeof record.url === 'string' ? record.url : '';
    if (!timestamp || !url) throw new Error('Common Crawl CDX record is missing a valid timestamp or URL.');
    captures.push({
      timestamp,
      url,
      status: typeof record.status === 'string' ? record.status : null,
    });
  }
  captures.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return captures[0] ?? null;
}

function isNoCapturesResponse(status: number, body: string): boolean {
  return (status === 400 || status === 404) && /no\s+captures\s+found/i.test(body);
}

function backoffMs(attempt: number, min: number, max: number, random: () => number): number {
  const base = Math.min(max, min * Math.pow(2, attempt - 1));
  return Math.floor(Math.min(max, base + base * 0.25 * random()));
}

function retryAfterMs(header: string | null, maxDelayMs: number, nowMs: number): number {
  if (!header) return 0;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelayMs, seconds * 1000);
  const parsed = Date.parse(header);
  if (Number.isNaN(parsed)) return 0;
  return Math.min(maxDelayMs, Math.max(0, parsed - nowMs));
}

export function createCommonCrawlHistoricalPresenceClient(config: CommonCrawlRuntimeConfig): HistoricalPresenceClient {
  if (config.provider !== 'common_crawl') throw new Error(`Unsupported historical-presence provider: ${config.provider || 'blank'}`);
  if (config.queryVersion !== HISTORICAL_PRESENCE_QUERY_VERSION) {
    throw new Error(`Unsupported historical-presence query version ${config.queryVersion}; expected ${HISTORICAL_PRESENCE_QUERY_VERSION}.`);
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const random = config.random ?? Math.random;
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const collectionsUrl = assertCommonCrawlUrl(config.collectionsUrl ?? COMMON_CRAWL_COLLECTIONS_URL);
  const userAgent = config.userAgent?.trim() || COMMON_CRAWL_USER_AGENT;
  let nextAvailableAt = 0;
  let consecutiveNetworkFailures = 0;
  let circuitOpenReason: string | null = null;
  let selectedCollectionsPromise: Promise<CommonCrawlCollection[]> | null = null;

  async function rateLimit(): Promise<void> {
    const wait = nextAvailableAt - now();
    if (wait > 0) await sleep(wait);
    nextAvailableAt = now() + config.minDelayMs;
  }

  async function requestText(url: string): Promise<{
    status: Exclude<HistoricalPresenceStatus, 'not_attempted'>;
    text: string | null;
    httpStatus: number | null;
    requestCount: number;
    error: string | null;
    sourceReason: string | null;
  }> {
    if (circuitOpenReason !== null) {
      return { status: 'unavailable', text: null, httpStatus: null, requestCount: 0, error: null, sourceReason: circuitOpenReason };
    }

    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      await rateLimit();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          redirect: 'error',
          headers: {
            Accept: 'application/json, application/x-ndjson, text/plain',
            'User-Agent': userAgent,
          },
        });
        const body = await response.text();
        consecutiveNetworkFailures = 0;
        if (response.ok) {
          return { status: 'ok', text: body, httpStatus: response.status, requestCount: attempt, error: null, sourceReason: null };
        }
        if (isNoCapturesResponse(response.status, body)) {
          return {
            status: 'not_found', text: null, httpStatus: response.status, requestCount: attempt, error: null,
            sourceReason: `Common Crawl reported no captures (HTTP ${response.status}).`,
          };
        }
        if (CIRCUIT_OPEN_HTTP_STATUSES.has(response.status)) {
          circuitOpenReason = `Common Crawl provider circuit open after HTTP ${response.status}`;
          return { status: 'unavailable', text: null, httpStatus: response.status, requestCount: attempt, error: null, sourceReason: circuitOpenReason };
        }
        if (RETRY_HTTP_STATUSES.has(response.status) && attempt < config.maxAttempts) {
          const retryAfter = retryAfterMs(response.headers.get('Retry-After'), config.maxDelayMs, now());
          await sleep(retryAfter > 0 ? retryAfter : backoffMs(attempt, config.baseDelayMs, config.maxDelayMs, random));
          continue;
        }
        return {
          status: 'error', text: null, httpStatus: response.status, requestCount: attempt,
          error: `Common Crawl returned HTTP ${response.status}`, sourceReason: null,
        };
      } catch (error) {
        consecutiveNetworkFailures += 1;
        if (consecutiveNetworkFailures >= config.maxAttempts) {
          circuitOpenReason = `Common Crawl provider circuit open after ${config.maxAttempts} consecutive network failures`;
          return { status: 'unavailable', text: null, httpStatus: null, requestCount: attempt, error: null, sourceReason: circuitOpenReason };
        }
        if (attempt < config.maxAttempts) {
          await sleep(backoffMs(attempt, config.baseDelayMs, config.maxDelayMs, random));
          continue;
        }
        return {
          status: 'error', text: null, httpStatus: null, requestCount: attempt,
          error: `Network error contacting Common Crawl: ${error instanceof Error ? error.message : String(error)}`,
          sourceReason: null,
        };
      } finally {
        clearTimeout(timer);
      }
    }
    return { status: 'error', text: null, httpStatus: null, requestCount: config.maxAttempts, error: 'Common Crawl lookup exhausted retries.', sourceReason: null };
  }

  async function loadSelectedCollections(): Promise<CommonCrawlCollection[]> {
    const response = await requestText(collectionsUrl);
    if (response.status !== 'ok' || response.text === null) {
      throw new Error(response.sourceReason ?? response.error ?? 'Common Crawl collection list unavailable.');
    }
    let value: unknown;
    try {
      value = JSON.parse(response.text) as unknown;
    } catch {
      throw new Error('Common Crawl collection list returned malformed JSON.');
    }
    return selectCommonCrawlCollections(parseCommonCrawlCollections(value), config.collectionMode, {
      nowMs: now(), recentMonths: config.recentMonths, maxCollections: config.maxCollections,
    });
  }

  async function collections(): Promise<CommonCrawlCollection[]> {
    selectedCollectionsPromise ??= loadSelectedCollections();
    return selectedCollectionsPromise;
  }

  async function lookup(domain: string): Promise<HistoricalPresenceResult> {
    const fetchedAt = new Date(now()).toISOString();
    let selected: CommonCrawlCollection[];
    try {
      selected = await collections();
    } catch (error) {
      return {
        domain,
        status: 'unavailable',
        earliestSampledCaptureAt: null,
        earliestSampledCaptureUrl: null,
        earliestSampledCaptureHttpStatus: null,
        earliestMatchedCollectionId: null,
        earliestMatchedCollectionFrom: null,
        earliestMatchedCollectionTo: null,
        historyCompleteForSelectedCollections: false,
        selectedCollectionCount: 0,
        checkedCollectionCount: 0,
        source: HISTORICAL_PRESENCE_SOURCE_COMMON_CRAWL,
        sourceReason: `Common Crawl collection list unavailable: ${error instanceof Error ? error.message : String(error)}`,
        error: null,
        fetchedAt,
        requestCount: 0,
        httpStatus: null,
      };
    }

    const attempts: CommonCrawlAttempt[] = [];
    let priorGap = false;
    for (const collection of selected) {
      const fetched = await requestText(buildCommonCrawlQuery(collection.cdxApi, domain));
      let status: HistoricalPresenceStatus = fetched.status;
      let capture: CommonCrawlCapture | null = null;
      let error = fetched.error;
      if (fetched.status === 'ok' && fetched.text !== null) {
        try {
          capture = parseCommonCrawlCaptureLines(fetched.text);
          status = capture ? 'ok' : 'not_found';
        } catch (parseError) {
          status = 'error';
          error = parseError instanceof Error ? parseError.message : String(parseError);
        }
      }
      attempts.push({ collection, status, capture, httpStatus: fetched.httpStatus, requestCount: fetched.requestCount, error, sourceReason: fetched.sourceReason });
      if (status === 'error' || status === 'unavailable') priorGap = true;
      if (status === 'unavailable') break;
      if (status === 'ok' && capture) {
        return {
          domain,
          status: 'ok',
          earliestSampledCaptureAt: capture.timestamp,
          earliestSampledCaptureUrl: capture.url,
          earliestSampledCaptureHttpStatus: capture.status,
          earliestMatchedCollectionId: collection.id,
          earliestMatchedCollectionFrom: collection.from,
          earliestMatchedCollectionTo: collection.to,
          historyCompleteForSelectedCollections: !priorGap,
          selectedCollectionCount: selected.length,
          checkedCollectionCount: attempts.length,
          source: HISTORICAL_PRESENCE_SOURCE_COMMON_CRAWL,
          sourceReason: priorGap
            ? 'A sampled capture was observed, but an earlier selected collection failed or was unavailable; earliest sampled presence is not fully established.'
            : 'Earliest sampled matching collection found with no earlier selected-collection gap. This is bounded sampled web-presence evidence, not exact first-seen.',
          error: null,
          fetchedAt,
          requestCount: attempts.reduce((sum, attempt) => sum + attempt.requestCount, 0),
          httpStatus: fetched.httpStatus,
        };
      }
    }

    const hasUnavailable = attempts.some((attempt) => attempt.status === 'unavailable');
    const hasError = attempts.some((attempt) => attempt.status === 'error');
    const status: HistoricalPresenceStatus = hasUnavailable ? 'unavailable' : hasError ? 'error' : 'not_found';
    const failing = attempts.find((attempt) => attempt.status === status);
    const last = attempts[attempts.length - 1];
    return {
      domain,
      status,
      earliestSampledCaptureAt: null,
      earliestSampledCaptureUrl: null,
      earliestSampledCaptureHttpStatus: null,
      earliestMatchedCollectionId: null,
      earliestMatchedCollectionFrom: null,
      earliestMatchedCollectionTo: null,
      historyCompleteForSelectedCollections: !hasUnavailable && !hasError,
      selectedCollectionCount: selected.length,
      checkedCollectionCount: attempts.length,
      source: HISTORICAL_PRESENCE_SOURCE_COMMON_CRAWL,
      sourceReason: status === 'not_found'
        ? 'No capture was observed in the selected Common Crawl collections. This is not proof that the domain never existed on the web.'
        : failing?.sourceReason ?? null,
      error: status === 'error' ? failing?.error ?? 'Common Crawl historical-presence lookup failed.' : null,
      fetchedAt,
      requestCount: attempts.reduce((sum, attempt) => sum + attempt.requestCount, 0),
      httpStatus: failing?.httpStatus ?? last?.httpStatus ?? null,
    };
  }

  return { source: HISTORICAL_PRESENCE_SOURCE_COMMON_CRAWL, queryVersion: HISTORICAL_PRESENCE_QUERY_VERSION, lookup };
}
