export const HISTORICAL_PRESENCE_QUERY_VERSION = 1;
export const HISTORICAL_PRESENCE_SOURCE_COMMON_CRAWL = 'common_crawl';

export type HistoricalPresenceStatus =
  | 'ok'
  | 'not_found'
  | 'unavailable'
  | 'not_attempted'
  | 'error';

export type HistoricalPresenceResult = {
  domain: string;
  status: HistoricalPresenceStatus;
  /**
   * Earliest capture observed by the configured bounded collection traversal.
   * This is sampled historical presence, NOT an exact first-ever web timestamp.
   */
  earliestSampledCaptureAt: string | null;
  earliestSampledCaptureUrl: string | null;
  earliestSampledCaptureHttpStatus: string | null;
  earliestMatchedCollectionId: string | null;
  earliestMatchedCollectionFrom: string | null;
  earliestMatchedCollectionTo: string | null;
  historyCompleteForSelectedCollections: boolean;
  selectedCollectionCount: number;
  checkedCollectionCount: number;
  source: string;
  sourceReason: string | null;
  error: string | null;
  fetchedAt: string;
  requestCount: number;
  /** Provider/index API HTTP status, not the archived page response status. */
  httpStatus: number | null;
};

export type HistoricalPresenceClient = {
  source: string;
  queryVersion: number;
  lookup: (domain: string) => Promise<HistoricalPresenceResult>;
};

export type HistoricalPresenceCollectionMode = 'latest' | 'annual';

export type HistoricalPresenceConfigSnapshot = {
  provider: '' | 'common_crawl';
  collectionMode: HistoricalPresenceCollectionMode;
  recentMonths: number;
  maxCollections: number;
  timeoutMs: number;
  minDelayMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  queryVersion: number;
};

export const DEFAULT_HISTORICAL_PRESENCE_CONFIG: HistoricalPresenceConfigSnapshot = {
  provider: 'common_crawl',
  collectionMode: 'annual',
  recentMonths: 18,
  maxCollections: 24,
  timeoutMs: 15_000,
  minDelayMs: 1_000,
  maxAttempts: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  queryVersion: HISTORICAL_PRESENCE_QUERY_VERSION,
};

export const HISTORICAL_PRESENCE_TTL_MS = {
  ok: 30 * 24 * 60 * 60 * 1000,
  notFound: 30 * 24 * 60 * 60 * 1000,
  unavailable: 24 * 60 * 60 * 1000,
  error: 60 * 60 * 1000,
} as const;

export function ttlMsForHistoricalPresenceStatus(status: HistoricalPresenceStatus): number {
  switch (status) {
    case 'ok':
      return HISTORICAL_PRESENCE_TTL_MS.ok;
    case 'not_found':
      return HISTORICAL_PRESENCE_TTL_MS.notFound;
    case 'unavailable':
    case 'not_attempted':
      return HISTORICAL_PRESENCE_TTL_MS.unavailable;
    case 'error':
      return HISTORICAL_PRESENCE_TTL_MS.error;
  }
}
