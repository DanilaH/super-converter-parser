// RDAP client: standards-based domain registration-date lookup.
//
// Flow:
//   1. Resolve the authoritative RDAP base URL(s) for the registrable domain via
//      the IANA bootstrap (RdapBootstrapResolver, cached in-memory).
//   2. Query each base URL, enforcing a per-host minimum delay, honoring
//      Retry-After, and applying bounded retry/backoff for transient failures.
//   3. Map HTTP outcome -> status and delegate body parsing to parse.ts.
//
// Mirrors the isolation/retry shape of createAhrefsClient (env/secret safety is
// handled by the caller — RDAP needs no key). fetchImpl, now, and random are
// injectable so the module is fully mock-testable.
import { ResearchError } from '../shared/errors.js';
import { registrableDomain } from '../domains/normalize.js';
import { RdapBootstrapResolver } from './bootstrap.js';
import { parseRdapDomainResponse } from './parse.js';
import {
  REGISTRATION_RULE_NO_EVENT,
  type RdapClient,
  type RdapClientConfig,
  type RdapRegistrationResult,
} from './types.js';

export { RDAP_PARSER_VERSION } from './types.js';

// Bounded exponential backoff with full jitter, identical shape to the Ahrefs
// client so retry cadence is consistent across network modules.
export function backoffMs(attempt: number, min: number, max: number, random: () => number): number {
  const base = Math.min(max, min * Math.pow(2, attempt - 1));
  const jitter = base * 0.25 * random();
  return Math.floor(Math.min(max, base + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null, fallbackSeconds: number): number {
  if (!header) return fallbackSeconds * 1000;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    const delta = parsed - Date.now();
    return delta > 0 ? delta : 0;
  }
  return fallbackSeconds * 1000;
}

export function createRdapClient(config: RdapClientConfig): RdapClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const resolver = new RdapBootstrapResolver(config, fetchImpl, now);
  const hostNextAvailable = new Map<string, number>();

  return async (domain: string): Promise<RdapRegistrationResult> => {
    const rdapDomain = registrableDomain(domain) ?? domain;
    const fetchedAt = new Date().toISOString();

    let baseUrls: string[] | null;
    try {
      baseUrls = await resolver.resolveBaseUrls(rdapDomain);
     } catch (error) {
      return errorResult(
        rdapDomain,
        fetchedAt,
        0,
        null,
        `bootstrap fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!baseUrls || baseUrls.length === 0) {
      return unsupportedOrNoRdap(rdapDomain, fetchedAt, 1);
    }

    let attempt = 0;
    for (const baseUrl of baseUrls) {
      for (attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
        const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const nextAvailable = hostNextAvailable.get(host);
        const waitMs = nextAvailable !== undefined ? nextAvailable - now() : 0;
        if (waitMs > 0) {
          await sleep(waitMs);
        }
        hostNextAvailable.set(host, now() + config.perHostMinDelayMs);

        const url = `${baseUrl.replace(/\/$/, '')}/domain/${encodeURIComponent(rdapDomain)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.queryTimeoutMs);
        let response: Response;
        try {
          response = await fetchImpl(url, {
            signal: controller.signal,
            headers: { Accept: 'application/rdap+json' },
          });
        } catch {
          clearTimeout(timer);
          if (attempt < config.maxAttempts) {
            await sleep(backoffMs(attempt, config.baseDelayMs, config.maxDelayMs, config.random));
            continue;
          }
          return errorResult(rdapDomain, fetchedAt, attempt, null, 'network error contacting RDAP server');
        } finally {
          clearTimeout(timer);
        }

        if (response.status === 200) {
          const body = (await response.json().catch(() => null)) as unknown;
          const parsed = parseRdapDomainResponse(rdapDomain, body, { fetchedAt });
          return { ...parsed, requestCount: attempt, httpStatus: 200 };
        }

        if (response.status === 404) {
          return {
            domain: rdapDomain,
            registrationDate: null,
            status: 'not_found',
            error: 'domain not found in RDAP',
            source: 'rdap',
            rule: REGISTRATION_RULE_NO_EVENT,
            events: [],
            isRedacted: false,
            fetchedAt,
            requestCount: attempt,
            httpStatus: 404,
          };
        }

        if (response.status === 410) {
          return unsupportedOrNoRdap(rdapDomain, fetchedAt, attempt, 410, {
            error: 'RDAP service gone (410) for this TLD',
          });
        }

        // 401/403 are systemic for a registry that shouldn't require auth on
        // public RDAP; treat as non-retriable errors (returned, not thrown).
        if (response.status === 401 || response.status === 403) {
          return errorResult(rdapDomain, fetchedAt, attempt, response.status, `RDAP auth error ${response.status}`);
        }

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = parseRetryAfter(
            response.headers.get('Retry-After'),
            backoffMs(attempt, config.baseDelayMs, config.maxDelayMs, config.random) / 1000,
          );
          if (attempt < config.maxAttempts) {
            await sleep(retryAfter);
            continue;
          }
          // Systemic/transient exhaustion: throw so the engine records a
          // structured per-domain error (RDAP_RATE_LIMIT / RDAP_ERROR), matching
          // the Ahrefs client contract rather than silently returning junk.
          throw new ResearchError(
            response.status === 429 ? 'RDAP_RATE_LIMIT' : 'RDAP_ERROR',
            response.status === 429
              ? `RDAP rate limited (429) after ${attempt} attempts`
              : `RDAP server error (${response.status}) after retries`,
          );
        }

        // Other 4xx (400, 404 handled above, 401/403 handled above): not retried.
        return errorResult(rdapDomain, fetchedAt, attempt, response.status, `RDAP error ${response.status}`);
      }
    }

    // Exhausted all base URLs without a definitive outcome.
    throw new ResearchError('RDAP_ERROR', 'RDAP lookup exhausted all base URLs');
  };
}

function baseError(
  domain: string,
  fetchedAt: string,
  requestCount: number,
  httpStatus: number | null,
  override: Partial<Pick<RdapRegistrationResult, 'status' | 'error'>> = {},
): RdapRegistrationResult {
  return {
    domain,
    registrationDate: null,
    status: override.status ?? 'error',
    error: override.error ?? null,
    source: 'rdap',
    rule: 'unreachable',
    events: [],
    isRedacted: false,
    fetchedAt,
    requestCount,
    httpStatus,
  };
}

function errorResult(
  domain: string,
  fetchedAt: string,
  requestCount: number,
  httpStatus: number | null,
  message: string,
): RdapRegistrationResult {
  return baseError(domain, fetchedAt, requestCount, httpStatus, {
    status: 'error',
    error: message,
  });
}

function unsupportedOrNoRdap(
  domain: string,
  fetchedAt: string,
  requestCount: number,
  httpStatus: number | null = null,
  override: Partial<Pick<RdapRegistrationResult, 'status' | 'error'>> = {},
): RdapRegistrationResult {
  return {
    domain,
    registrationDate: null,
    status: override.status ?? 'unsupported',
    error: override.error ?? null,
    source: 'rdap',
    rule: REGISTRATION_RULE_NO_EVENT,
    events: [],
    isRedacted: false,
    fetchedAt,
    requestCount,
    httpStatus,
  };
}
