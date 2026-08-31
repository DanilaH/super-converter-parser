export const COMMON_CRAWL_SOURCE = 'common_crawl';
export const COMMON_CRAWL_COLLECTIONS_URL = 'https://index.commoncrawl.org/collinfo.json';

export type HistoricalSourceStatus = 'ok' | 'not_found' | 'unavailable' | 'not_attempted' | 'error';
export type CommonCrawlCollectionMode = 'latest' | 'annual' | 'all';

export type CommonCrawlCollection = {
  id: string;
  name: string;
  cdxApi: string;
  from: string | null;
  to: string | null;
};

export type CommonCrawlCapture = {
  timestamp: string;
  url: string;
  status: string | null;
  urlKey: string | null;
};

export type CommonCrawlAttempt = {
  collectionId: string;
  collectionFrom: string | null;
  collectionTo: string | null;
  status: HistoricalSourceStatus;
  captureAt: string | null;
  captureUrl: string | null;
  httpStatus: number | null;
  requestCount: number;
  requestLatenciesMs: number[];
  error: string | null;
  sourceReason: string | null;
};

export type CommonCrawlDomainResult = {
  domain: string;
  status: HistoricalSourceStatus;
  earliestSampledCaptureAt: string | null;
  earliestSampledCaptureUrl: string | null;
  earliestMatchedCollectionId: string | null;
  earliestMatchedCollectionFrom: string | null;
  earliestMatchedCollectionTo: string | null;
  historyCompleteForSelectedCollections: boolean;
  selectedCollectionCount: number;
  checkedCollectionCount: number;
  requestCount: number;
  requestLatenciesMs: number[];
  attempts: CommonCrawlAttempt[];
  source: typeof COMMON_CRAWL_SOURCE;
  sourceReason: string | null;
};

export type CommonCrawlClientConfig = {
  collectionsUrl?: string;
  timeoutMs: number;
  minDelayMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const RETRY_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const CIRCUIT_OPEN_HTTP_STATUSES = new Set([403, 451]);
const COMMON_CRAWL_ORIGIN = 'https://index.commoncrawl.org';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function assertCommonCrawlEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid Common Crawl CDX endpoint: ${raw}`);
  }
  if (parsed.origin !== COMMON_CRAWL_ORIGIN || parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-Common-Crawl CDX endpoint: ${raw}`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export function parseCommonCrawlCollections(value: unknown): CommonCrawlCollection[] {
  if (!Array.isArray(value)) {
    throw new Error('Common Crawl collection list is not an array.');
  }

  const parsed: CommonCrawlCollection[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const cdxApiRaw = typeof record['cdx-api'] === 'string' ? record['cdx-api'].trim() : '';
    if (!id.startsWith('CC-MAIN-') || !cdxApiRaw) continue;
    parsed.push({
      id,
      name: name || id,
      cdxApi: assertCommonCrawlEndpoint(cdxApiRaw),
      from: validIso(record.from),
      to: validIso(record.to),
    });
  }

  if (parsed.length === 0) {
    throw new Error('Common Crawl collection list contains no usable CC-MAIN collections.');
  }

  return parsed.sort((a, b) => {
    const aTime = a.from ? Date.parse(a.from) : Number.POSITIVE_INFINITY;
    const bTime = b.from ? Date.parse(b.from) : Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    return a.id.localeCompare(b.id);
  });
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

/**
 * Common Crawl publishes one CDXJ index per crawl, not one cumulative index.
 * Annual mode samples the oldest crawl of every year plus all recent crawls.
 * It is deliberately bounded historical evidence, not exact first-ever capture.
 */
export function selectCommonCrawlCollections(
  collections: CommonCrawlCollection[],
  mode: CommonCrawlCollectionMode,
  options: { nowMs: number; recentMonths?: number; maxCollections?: number | null },
): CommonCrawlCollection[] {
  const sorted = [...collections].sort((a, b) => {
    const aTime = a.from ? Date.parse(a.from) : Number.POSITIVE_INFINITY;
    const bTime = b.from ? Date.parse(b.from) : Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    return a.id.localeCompare(b.id);
  });

  if (mode === 'latest') {
    return sorted.length === 0 ? [] : [sorted[sorted.length - 1] as CommonCrawlCollection];
  }

  if (mode === 'all') {
    if (options.maxCollections === null || options.maxCollections === undefined) return sorted;
    return sorted.slice(0, Math.max(0, options.maxCollections));
  }

  const annual = new Map<number, CommonCrawlCollection>();
  for (const collection of sorted) {
    const year = collectionYear(collection);
    if (year !== null && !annual.has(year)) annual.set(year, collection);
  }

  const cutoff = monthCutoff(options.nowMs, options.recentMonths ?? 18);
  const selected = new Map<string, CommonCrawlCollection>();
  for (const collection of annual.values()) selected.set(collection.id, collection);
  for (const collection of sorted) {
    const boundary = collection.to ?? collection.from;
    if (boundary && Date.parse(boundary) >= cutoff) selected.set(collection.id, collection);
  }

  let result = [...selected.values()].sort((a, b) => {
    const aTime = a.from ? Date.parse(a.from) : Number.POSITIVE_INFINITY;
    const bTime = b.from ? Date.parse(b.from) : Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    return a.id.localeCompare(b.id);
  });

  const maxCollections = options.maxCollections;
  if (maxCollections !== null && maxCollections !== undefined && result.length > maxCollections) {
    const mandatoryAnnual = new Set(annual.values());
    const mandatory = result.filter((item) => mandatoryAnnual.has(item));
    if (mandatory.length >= maxCollections) {
      result = mandatory.slice(0, maxCollections);
    } else {
      const extras = result
        .filter((item) => !mandatoryAnnual.has(item))
        .slice(-(maxCollections - mandatory.length));
      result = [...mandatory, ...extras].sort((a, b) => {
        const aTime = a.from ? Date.parse(a.from) : Number.POSITIVE_INFINITY;
        const bTime = b.from ? Date.parse(b.from) : Number.POSITIVE_INFINITY;
        if (aTime !== bTime) return aTime - bTime;
        return a.id.localeCompare(b.id);
      });
    }
  }

  return result;
}

export function buildCommonCrawlQuery(cdxApi: string, domain: string): string {
  const url = new URL(assertCommonCrawlEndpoint(cdxApi));
  url.search = '';
  url.searchParams.set('url', domain);
  url.searchParams.set('output', 'json');
  url.searchParams.set('matchType', 'domain');
  // Any indexed capture is enough for the spike's web-presence question. Do
  // not server-filter a large domain down to status=200: pywb filters may scan
  // many captures and put unnecessary load on the public index service.
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
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
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
    const timestampRaw = typeof record.timestamp === 'string' ? record.timestamp : '';
    const timestamp = parseCompactTimestamp(timestampRaw);
    const url = typeof record.url === 'string' ? record.url : '';
    if (!timestamp || !url) {
      throw new Error('Common Crawl CDX record is missing a valid timestamp or URL.');
    }
    captures.push({
      timestamp,
      url,
      status: typeof record.status === 'string' ? record.status : null,
      urlKey: typeof record.urlkey === 'string' ? record.urlkey : null,
    });
  }

  captures.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return captures[0] ?? null;
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

export function createCommonCrawlHistoryClient(config: CommonCrawlClientConfig): {
  loadCollections: () => Promise<CommonCrawlCollection[]>;
  lookupDomain: (domain: string, collections: CommonCrawlCollection[]) => Promise<CommonCrawlDomainResult>;
} {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const random = config.random ?? Math.random;
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const collectionsUrl = config.collectionsUrl ?? COMMON_CRAWL_COLLECTIONS_URL;
  let nextAvailableAt = 0;
  let consecutiveNetworkFailures = 0;
  let circuitOpenReason: string | null = null;

  async function rateLimit(): Promise<void> {
    const wait = nextAvailableAt - now();
    if (wait > 0) await sleep(wait);
    nextAvailableAt = now() + config.minDelayMs;
  }

  async function requestText(url: string): Promise<{
    status: 'ok' | 'unavailable' | 'error';
    text: string | null;
    httpStatus: number | null;
    requestCount: number;
    requestLatenciesMs: number[];
    error: string | null;
    sourceReason: string | null;
  }> {
    if (circuitOpenReason !== null) {
      return {
        status: 'unavailable',
        text: null,
        httpStatus: null,
        requestCount: 0,
        requestLatenciesMs: [],
        error: null,
        sourceReason: circuitOpenReason,
      };
    }

    const latencies: number[] = [];
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      await rateLimit();
      const startedAt = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          redirect: 'error',
          headers: { Accept: 'application/json, application/x-ndjson, text/plain' },
        });
        const text = await response.text();
        clearTimeout(timer);
        latencies.push(Math.max(0, now() - startedAt));
        consecutiveNetworkFailures = 0;

        if (response.ok) {
          return {
            status: 'ok',
            text,
            httpStatus: response.status,
            requestCount: attempt,
            requestLatenciesMs: latencies,
            error: null,
            sourceReason: null,
          };
        }

        if (CIRCUIT_OPEN_HTTP_STATUSES.has(response.status)) {
          circuitOpenReason = `Common Crawl provider circuit open after HTTP ${response.status}`;
          return {
            status: 'unavailable',
            text: null,
            httpStatus: response.status,
            requestCount: attempt,
            requestLatenciesMs: latencies,
            error: null,
            sourceReason: circuitOpenReason,
          };
        }

        if (RETRY_HTTP_STATUSES.has(response.status) && attempt < config.maxAttempts) {
          const retryAfter = retryAfterMs(response.headers.get('Retry-After'), config.maxDelayMs, now());
          await sleep(retryAfter > 0 ? retryAfter : backoffMs(attempt, config.baseDelayMs, config.maxDelayMs, random));
          continue;
        }

        return {
          status: 'error',
          text: null,
          httpStatus: response.status,
          requestCount: attempt,
          requestLatenciesMs: latencies,
          error: `Common Crawl returned HTTP ${response.status}`,
          sourceReason: null,
        };
      } catch (error) {
        clearTimeout(timer);
        latencies.push(Math.max(0, now() - startedAt));
        consecutiveNetworkFailures += 1;
        if (consecutiveNetworkFailures >= config.maxAttempts) {
          circuitOpenReason = `Common Crawl provider circuit open after ${config.maxAttempts} consecutive network failures`;
          return {
            status: 'unavailable',
            text: null,
            httpStatus: null,
            requestCount: attempt,
            requestLatenciesMs: latencies,
            error: null,
            sourceReason: circuitOpenReason,
          };
        }
        if (attempt < config.maxAttempts) {
          await sleep(backoffMs(attempt, config.baseDelayMs, config.maxDelayMs, random));
          continue;
        }
        return {
          status: 'error',
          text: null,
          httpStatus: null,
          requestCount: attempt,
          requestLatenciesMs: latencies,
          error: `Network error contacting Common Crawl: ${error instanceof Error ? error.message : String(error)}`,
          sourceReason: null,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      status: 'error',
      text: null,
      httpStatus: null,
      requestCount: config.maxAttempts,
      requestLatenciesMs: latencies,
      error: 'Common Crawl lookup exhausted retries.',
      sourceReason: null,
    };
  }

  async function loadCollections(): Promise<CommonCrawlCollection[]> {
    const parsedUrl = new URL(collectionsUrl);
    if (parsedUrl.origin !== COMMON_CRAWL_ORIGIN || parsedUrl.protocol !== 'https:') {
      throw new Error(`Refusing non-Common-Crawl collection list URL: ${collectionsUrl}`);
    }
    const response = await requestText(parsedUrl.toString());
    if (response.status !== 'ok' || response.text === null) {
      throw new Error(response.sourceReason ?? response.error ?? 'Common Crawl collection list unavailable.');
    }
    let value: unknown;
    try {
      value = JSON.parse(response.text) as unknown;
    } catch {
      throw new Error('Common Crawl collection list returned malformed JSON.');
    }
    return parseCommonCrawlCollections(value);
  }

  async function lookupDomain(
    domain: string,
    collections: CommonCrawlCollection[],
  ): Promise<CommonCrawlDomainResult> {
    const attempts: CommonCrawlAttempt[] = [];
    let priorGap = false;

    for (const collection of collections) {
      const fetched = await requestText(buildCommonCrawlQuery(collection.cdxApi, domain));
      let status: HistoricalSourceStatus = fetched.status;
      let capture: CommonCrawlCapture | null = null;
      let parseError: string | null = null;

      if (fetched.status === 'ok' && fetched.text !== null) {
        try {
          capture = parseCommonCrawlCaptureLines(fetched.text);
          status = capture ? 'ok' : 'not_found';
        } catch (error) {
          status = 'error';
          parseError = error instanceof Error ? error.message : String(error);
        }
      }

      const attempt: CommonCrawlAttempt = {
        collectionId: collection.id,
        collectionFrom: collection.from,
        collectionTo: collection.to,
        status,
        captureAt: capture?.timestamp ?? null,
        captureUrl: capture?.url ?? null,
        httpStatus: fetched.httpStatus,
        requestCount: fetched.requestCount,
        requestLatenciesMs: fetched.requestLatenciesMs,
        error: parseError ?? fetched.error,
        sourceReason: fetched.sourceReason,
      };
      attempts.push(attempt);

      if (status === 'error' || status === 'unavailable') priorGap = true;
      if (status === 'unavailable') break;
      if (status === 'ok' && capture) {
        const requestLatenciesMs = attempts.flatMap((item) => item.requestLatenciesMs);
        return {
          domain,
          status: 'ok',
          earliestSampledCaptureAt: capture.timestamp,
          earliestSampledCaptureUrl: capture.url,
          earliestMatchedCollectionId: collection.id,
          earliestMatchedCollectionFrom: collection.from,
          earliestMatchedCollectionTo: collection.to,
          historyCompleteForSelectedCollections: !priorGap,
          selectedCollectionCount: collections.length,
          checkedCollectionCount: attempts.length,
          requestCount: attempts.reduce((sum, item) => sum + item.requestCount, 0),
          requestLatenciesMs,
          attempts,
          source: COMMON_CRAWL_SOURCE,
          sourceReason: priorGap
            ? 'A sampled capture was observed, but at least one earlier selected collection failed or was unavailable; earliest sampled presence is not fully established.'
            : 'Earliest sampled matching crawl found. Common Crawl has no cumulative CDXJ index, and limit=1 proves crawl/index presence rather than the first capture inside that crawl.',
        };
      }
    }

    const requestLatenciesMs = attempts.flatMap((item) => item.requestLatenciesMs);
    const hasUnavailable = attempts.some((item) => item.status === 'unavailable');
    const hasError = attempts.some((item) => item.status === 'error');
    const status: HistoricalSourceStatus = hasUnavailable ? 'unavailable' : hasError ? 'error' : 'not_found';
    const failingAttempt = attempts.find((item) => item.status === status);
    return {
      domain,
      status,
      earliestSampledCaptureAt: null,
      earliestSampledCaptureUrl: null,
      earliestMatchedCollectionId: null,
      earliestMatchedCollectionFrom: null,
      earliestMatchedCollectionTo: null,
      historyCompleteForSelectedCollections: !hasUnavailable && !hasError,
      selectedCollectionCount: collections.length,
      checkedCollectionCount: attempts.length,
      requestCount: attempts.reduce((sum, item) => sum + item.requestCount, 0),
      requestLatenciesMs,
      attempts,
      source: COMMON_CRAWL_SOURCE,
      sourceReason: status === 'not_found'
        ? 'No capture was observed in the selected Common Crawl collections. This is not proof that the domain never existed on the web.'
        : failingAttempt?.sourceReason ?? failingAttempt?.error ?? null,
    };
  }

  return { loadCollections, lookupDomain };
}
