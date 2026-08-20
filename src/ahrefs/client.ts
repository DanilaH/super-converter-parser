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

const MAX_ATTEMPTS = 3;

// Endpoint and query shape are isolated here so the exact Ahrefs API version
// (free Domain Rating) can be finalized without touching callers.
export function createAhrefsClient(
  apiKey: string,
  overrides: Partial<AhrefsClientConfig> = {},
): AhrefsClient {
  const config: AhrefsClientConfig = {
    apiKey,
    endpoint: overrides.endpoint ?? 'https://apiv2.ahrefs.com/',
    timeoutMs: overrides.timeoutMs ?? 15000,
    minDelayMs: overrides.minDelayMs ?? 1000,
    maxDelayMs: overrides.maxDelayMs ?? 10000,
    fetchImpl: overrides.fetchImpl,
  };
  const fetchImpl = config.fetchImpl ?? fetch;
  return async (domain: string): Promise<DomainRatingResult> => {
    const fetchedAt = new Date().toISOString();
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        response = await fetchImpl(
          `${config.endpoint}?token=${encodeURIComponent(config.apiKey)}&from=domain_rating&target=${encodeURIComponent(domain)}`,
          { signal: controller.signal },
        );
        clearTimeout(timer);
      } catch {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(config.minDelayMs);
          continue;
        }
        return { domain, dr: null, fetchedAt, source: 'ahrefs', status: 'error', error: 'network' };
      }

      if (response.status === 404) {
        return { domain, dr: null, fetchedAt, source: 'ahrefs', status: 'not_found', error: null };
      }
      if (response.status === 429) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(config.minDelayMs);
          continue;
        }
        throw new ResearchError('AHREFS_RATE_LIMIT', `Ahrefs rate limit hit for "${domain}".`);
      }
      if (response.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(config.minDelayMs);
          continue;
        }
        throw new ResearchError('AHREFS_ERROR', `Ahrefs server error ${response.status} for "${domain}".`);
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

      const payload = (await response.json()) as { domain_rating?: number | null; dr?: number | null };
      const dr = payload.domain_rating ?? payload.dr ?? null;
      return { domain, dr, fetchedAt, source: 'ahrefs', status: 'ok', error: null };
    }
    return { domain, dr: null, fetchedAt, source: 'ahrefs', status: 'error', error: 'unreachable' };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
