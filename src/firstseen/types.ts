// First-seen enrichment types.
//
// First-seen is a *separate* fact from registration date and is fetched from a
// different, explicitly configured source. The two can never alias one another:
// a null firstSeenDate is never back-filled from registrationDate.

export type FirstSeenStatus = 'ok' | 'not_found' | 'unavailable' | 'not_attempted' | 'error';

// A first-seen lookup result. `source` is the provider name (e.g. 'wayback') or
// 'unconfigured'/'none' when no provider was configured, so provenance is always
// traceable.
export type FirstSeenResult = {
  domain: string;
  firstSeenDate: string | null;
  status: FirstSeenStatus;
  error: string | null;
  source: string;
  sourceReason: string | null;
  fetchedAt: string;
  requestCount: number;
  httpStatus: number | null;
};

export type FirstSeenClient = (domain: string) => Promise<FirstSeenResult>;

export type FirstSeenClientConfig = {
  provider: string;
  endpoint: string;
  apiKey: string | null;
  timeoutMs: number;
  minDelayMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  fetchImpl?: typeof fetch | undefined;
  // Test seams (mirror the hooks pattern used by runs/engine applyDomainRatings).
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};
