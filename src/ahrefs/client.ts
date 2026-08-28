import { ResearchError } from '../shared/errors.js';

export type DomainRatingResult = {
  domain: string;
  dr: number | null;
  fetchedAt: string;
  source: 'ahrefs';
  status: 'ok' | 'not_found' | 'error';
  error: string | null;
};

export type AhrefsClient = (domain: string) => Promise<DomainRatingResult>;

export type AhrefsClientConfig = {
  apiKey: string;
  endpoint: string;
  timeoutMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  fetchImpl?: typeof fetch | undefined;
};

// v3 public Domain Rating (free) endpoint. Returns a nested payload:
//   { "domain_rating": { "domain_rating": <number> } }
// Authentication is the official bearer token; the caller is required to supply
// a key (this tool gates DR enrichment on AHREFS_API_KEY).
const DEFAULT_ENDPOINT = 'https://api.ahrefs.com/v3/public/domain-rating-free';
const MAX_ATTEMPTS = 4;

// Bounded exponential backoff with full jitter: base doubles per attempt and is
// capped at maxDelayMs, then a random fraction [0, 0.25 * base] is added so
// concurrent retries do not synchronize. The total (base + jitter) is clamped
// to maxDelayMs so the delay never exceeds the configured ceiling.
export function backoffMs(attempt: number, min: number, max: number, random: () => number): number {
  const base = Math.min(max, min * Math.pow(2, attempt - 1));
  const jitter = base * 0.25 * random();
  return Math.floor(Math.min(max, base + jitter));
}

// Endpoint, auth header and response shape are isolated here so the exact
// Ahrefs API version can be finalized without touching callers.
export function createAhrefsClient(
  apiKey: string,
  overrides: Partial<AhrefsClientConfig> = {},
): AhrefsClient {
  const config: AhrefsClientConfig = {
    apiKey,
    endpoint: overrides.endpoint ?? DEFAULT_ENDPOINT,
    timeoutMs: overrides.timeoutMs ?? 15000,
    minDelayMs: overrides.minDelayMs ?? 1000,
    maxDelayMs: overrides.maxDelayMs ?? 10000,
    fetchImpl: overrides.fetchImpl,
  };
  const fetchImpl = config.fetchImpl ?? fetch;
  return async (domain: string): Promise<DomainRatingResult> => {
    const fetchedAt = new Date().toISOString();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(
          `${config.endpoint}?target=${encodeURIComponent(domain)}`,
          { signal: controller.signal, headers },
        );

        if (response.status === 404) {
          return { domain, dr: null, fetchedAt, source: 'ahrefs', status: 'not_found', error: null };
        }
        if (response.status === 429) {
          if (attempt < MAX_ATTEMPTS) {
            // The timeout governs the network operation itself. Retry pacing is
            // separately bounded by maxDelayMs.
            clearTimeout(timer);
            await sleep(backoffMs(attempt, config.minDelayMs, config.maxDelayMs, Math.random));
            continue;
          }
          throw new ResearchError('AHREFS_RATE_LIMIT', `Ahrefs rate limit hit for "${domain}".`, { httpStatus: 429 });
        }
        if (response.status >= 500) {
          if (attempt < MAX_ATTEMPTS) {
            clearTimeout(timer);
            await sleep(backoffMs(attempt, config.minDelayMs, config.maxDelayMs, Math.random));
            continue;
          }
          throw new ResearchError('AHREFS_ERROR', `Ahrefs server error ${response.status} for "${domain}".`, { httpStatus: response.status });
        }
        // 401/403 are auth/systemic failures: unusable key. Throw (don't return a
        // plain error result) so the stage can be marked failed and no doomed
        // fan-out occurs for the remaining domains.
        if (response.status === 401 || response.status === 403) {
          throw new ResearchError('AHREFS_ERROR', `Ahrefs auth rejected (${response.status}) for "${domain}".`, { httpStatus: response.status });
        }
        if (!response.ok) {
          return {
            domain,
            dr: null,
            fetchedAt,
            source: 'ahrefs',
            status: 'error',
            error: `status ${response.status}`,
          };
        }

        // Keep the abort timer active through body consumption. A server that
        // sends headers and then stalls the JSON body must not hang the run.
        const payload = (await response.json()) as {
          domain_rating?: { domain_rating?: number | null } | null;
          dr?: number | null;
        };
        const dr = payload.domain_rating?.domain_rating ?? payload.dr ?? null;
        return { domain, dr, fetchedAt, source: 'ahrefs', status: 'ok', error: null };
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt, config.minDelayMs, config.maxDelayMs, Math.random));
          continue;
        }
        return { domain, dr: null, fetchedAt, source: 'ahrefs', status: 'error', error: 'network' };
      } finally {
        // Release the timer after both headers and any required body have been
        // consumed (or after an abort/error).
        clearTimeout(timer);
      }
    }
    return { domain, dr: null, fetchedAt, source: 'ahrefs', status: 'error', error: 'unreachable' };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
