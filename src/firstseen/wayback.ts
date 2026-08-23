// Wayback Machine CDX API first-seen provider.
//
// Source: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
// Query: GET https://web.archive.org/cdx/search/cdx?url=<domain>&output=json&limit=1&from=1990&fl=timestamp
//
// Match semantics: `url` is the registrable domain. CDX's `url` filter matches the
// registrable domain and any of its subdomains (host equals the domain or ends with
// `.<domain>`), and does NOT match unrelated hosts that merely contain the domain
// string (e.g. `example.com` will not match `example.com.evil.net`). This is the
// intended domain first-seen signal: the earliest archived snapshot of the domain
// or any subdomain.
//
// Response shape (with `fl=timestamp`): a JSON array of rows. Row 0 is the column
// header (["timestamp"]); the first capture follows. The timestamp column index is
// resolved from the header rather than assumed, so the parser stays correct even if
// CDX's default column ordering changes. CDX timestamps are compact UTC
// `YYYYMMDDhhmmss` (left-truncated prefixes are accepted).
//
// CDX returns captures chronologically ascending by default, so `limit=1` yields the
// oldest (first-seen) snapshot. This is a real, documented, unauthenticated first-seen
// signal — NOT registration data, NOT SERP presence.
import type { FirstSeenClient, FirstSeenClientConfig, FirstSeenResult } from './types.js';

export const WAYBACK_SOURCE = 'wayback';
export const WAYBACK_DEFAULT_ENDPOINT = 'https://web.archive.org/cdx/search/cdx';

const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseWaybackTimestamp(ts: string): string | null {
  const digits = ts.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const padded = digits.padEnd(14, '0').slice(0, 14);
  const y = padded.slice(0, 4);
  const mo = padded.slice(4, 6);
  const d = padded.slice(6, 8);
  const h = padded.slice(8, 10);
  const mi = padded.slice(10, 12);
  const s = padded.slice(12, 14);
  // ISO 8601 UTC; CDX timestamps are UTC.
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

export function buildWaybackQuery(endpoint: string, domain: string): string {
  const base = endpoint || WAYBACK_DEFAULT_ENDPOINT;
  // `fl=timestamp` pins the response column so row[0] is guaranteed to be the
  // capture timestamp (the undocumented default columns start with urlkey).
  const params = new URLSearchParams({
    url: domain,
    output: 'json',
    limit: '1',
    from: '1990',
    fl: 'timestamp',
  });
  return `${base}/?${params.toString()}`;
}

// Exponential backoff with full jitter, matching the RDAP/Ahrefs cadence.
function backoffMs(attempt: number, min: number, max: number): number {
  const base = Math.min(max, min * Math.pow(2, attempt - 1));
  const jitter = base * 0.25 * Math.random();
  return Math.floor(Math.min(max, base + jitter));
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const parsed = Date.parse(header);
  if (Number.isFinite(parsed)) return Math.max(0, parsed - Date.now());
  return 0;
}

function errorResult(
  domain: string,
  fetchedAt: string,
  requestCount: number,
  httpStatus: number | null,
  message: string,
): FirstSeenResult {
  return {
    domain,
    firstSeenDate: null,
    status: 'error',
    error: message,
    source: WAYBACK_SOURCE,
    sourceReason: null,
    fetchedAt,
    requestCount,
    httpStatus,
  };
}

export function createWaybackClient(config: FirstSeenClientConfig, now: () => number = Date.now): FirstSeenClient {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  void now;
  void DEFAULT_TIMEOUT_MS;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs;
  const attempts = config.maxAttempts ?? MAX_ATTEMPTS;

  return async (domain: string): Promise<FirstSeenResult> => {
    const fetchedAt = new Date().toISOString();

    let attempt = 0;
    for (attempt = 1; attempt <= attempts; attempt += 1) {
      const url = buildWaybackQuery(config.endpoint, domain);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
      } catch {
        clearTimeout(timer);
        if (attempt < attempts) {
          await sleep(backoffMs(attempt, config.baseDelayMs, config.maxDelayMs));
          continue;
        }
        return errorResult(domain, fetchedAt, attempt, null, 'network error contacting Wayback CDX');
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        if (response.status === 429 && attempt < attempts) {
          const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
          await sleep(retryAfter > 0 ? retryAfter : backoffMs(attempt, config.baseDelayMs, config.maxDelayMs));
          continue;
        }
        return errorResult(
          domain,
          fetchedAt,
          attempt,
          response.status,
          `Wayback CDX returned HTTP ${response.status}`,
        );
      }

      const data = await response.json().catch(() => null) as unknown;
      if (!Array.isArray(data)) {
        return errorResult(domain, fetchedAt, attempt, response.status, 'malformed Wayback CDX response (not an array)');
      }

      // Row 0 is the column header; the first data row follows. Resolve the
      // timestamp column index from the header so we never assume a position.
      if (data.length < 2) {
        return {
          domain,
          firstSeenDate: null,
          status: 'ok',
          error: null,
          source: WAYBACK_SOURCE,
          sourceReason: 'no archived snapshots returned by Wayback CDX',
          fetchedAt,
          requestCount: attempt,
          httpStatus: response.status,
        };
      }
      const header = Array.isArray(data[0]) ? (data[0] as unknown[]) : [];
      const tsIndex = header.findIndex((col) => col === 'timestamp');
      if (tsIndex < 0) {
        return errorResult(
          domain,
          fetchedAt,
          attempt,
          response.status,
          `Wayback CDX header missing 'timestamp' column: ${JSON.stringify(header)}`,
        );
      }
      const row = data[1] as unknown[];
      const ts = tsIndex < row.length ? row[tsIndex] : null;
      const iso = typeof ts === 'string' ? parseWaybackTimestamp(ts) : null;
      if (iso === null) {
        return errorResult(domain, fetchedAt, attempt, response.status, `unparseable Wayback timestamp: ${ts}`);
      }
      return {
        domain,
        firstSeenDate: iso,
        status: 'ok',
        error: null,
        source: WAYBACK_SOURCE,
        sourceReason: null,
        fetchedAt,
        requestCount: attempt,
        httpStatus: response.status,
      };
    }

    return errorResult(domain, fetchedAt, attempt, null, 'Wayback CDX lookup exhausted retries');
  };
}
