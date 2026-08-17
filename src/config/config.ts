import { ResearchError } from '../shared/errors.js';
import { SURFER_MARKERS } from '../surfer/selectors.js';

export type ResearchConfig = {
  research: {
    market: string;
    googleHl: string;
    googleGl: string;
    topN: number;
  };
  browser: {
    cdpUrl: string;
    navigationTimeoutMs: number;
    surferWaitTimeoutMs: number;
    surferPreflightTimeoutMs: number;
    surferWidgetSelector: string;
  };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  circuitBreaker: {
    surferWindow: number;
    surferFailureThreshold: number;
    googleConsecutiveThreshold: number;
  };
  cache: {
    path: string;
    ttl: {
      completedMs: number;
      partialMs: number;
      failedMs: number;
      relatedMs: number;
      domainOkMs: number;
      domainNotFoundMs: number;
      domainErrorMs: number;
    };
  };
};

const DEFAULTS: ResearchConfig = {
  research: {
    market: 'US',
    googleHl: 'en',
    googleGl: 'us',
    topN: 10,
  },
  browser: {
    cdpUrl: 'http://127.0.0.1:9222',
    navigationTimeoutMs: 60_000,
    surferWaitTimeoutMs: 60_000,
    surferPreflightTimeoutMs: 60_000,
    surferWidgetSelector: SURFER_MARKERS.mainWidget,
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 15_000,
  },
  circuitBreaker: {
    surferWindow: 15,
    surferFailureThreshold: 12,
    googleConsecutiveThreshold: 10,
  },
  cache: {
    path: 'data/cache/cache.sqlite',
    ttl: {
      completedMs: 7 * 24 * 60 * 60 * 1000,
      partialMs: 6 * 60 * 60 * 1000,
      failedMs: 60 * 60 * 1000,
      relatedMs: 7 * 24 * 60 * 60 * 1000,
      domainOkMs: 30 * 24 * 60 * 60 * 1000,
      domainNotFoundMs: 30 * 24 * 60 * 60 * 1000,
      domainErrorMs: 60 * 60 * 1000,
    },
  },
};

function readPositiveNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid ${name}: expected a non-negative number, got "${value}".`,
    );
  }
  return parsed;
}

function readPositiveInt(name: string, value: string | undefined, fallback: number): number {
  const parsed = readPositiveNumber(name, value, fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid ${name}: expected a positive integer, got "${value}".`,
    );
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResearchConfig {
  const topN = readPositiveNumber('TOP_N', env.TOP_N, DEFAULTS.research.topN);
  if (topN < 1 || topN > 30) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid TOP_N: expected a number between 1 and 30, got "${topN}".`,
    );
  }

  const retry = {
    maxAttempts: readPositiveInt('RETRY_MAX_ATTEMPTS', env.RETRY_MAX_ATTEMPTS, DEFAULTS.retry.maxAttempts),
    baseDelayMs: readPositiveNumber('RETRY_BASE_DELAY_MS', env.RETRY_BASE_DELAY_MS, DEFAULTS.retry.baseDelayMs),
    maxDelayMs: readPositiveNumber('RETRY_MAX_DELAY_MS', env.RETRY_MAX_DELAY_MS, DEFAULTS.retry.maxDelayMs),
  };

  const circuitBreaker = {
    surferWindow: readPositiveInt('BREAKER_SURFER_WINDOW', env.BREAKER_SURFER_WINDOW, DEFAULTS.circuitBreaker.surferWindow),
    surferFailureThreshold: readPositiveInt(
      'BREAKER_SURFER_FAILURES',
      env.BREAKER_SURFER_FAILURES,
      DEFAULTS.circuitBreaker.surferFailureThreshold,
    ),
    googleConsecutiveThreshold: readPositiveInt(
      'BREAKER_GOOGLE_CONSECUTIVE',
      env.BREAKER_GOOGLE_CONSECUTIVE,
      DEFAULTS.circuitBreaker.googleConsecutiveThreshold,
    ),
  };

  if (circuitBreaker.surferFailureThreshold > circuitBreaker.surferWindow) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid BREAKER_SURFER_FAILURES: expected at most BREAKER_SURFER_WINDOW (${circuitBreaker.surferWindow}), got ${circuitBreaker.surferFailureThreshold}.`,
    );
  }

  const cacheTtl = {
    completedMs: readPositiveInt('CACHE_TTL_COMPLETED_MS', env.CACHE_TTL_COMPLETED_MS, DEFAULTS.cache.ttl.completedMs),
    partialMs: readPositiveInt('CACHE_TTL_PARTIAL_MS', env.CACHE_TTL_PARTIAL_MS, DEFAULTS.cache.ttl.partialMs),
    failedMs: readPositiveInt('CACHE_TTL_FAILED_MS', env.CACHE_TTL_FAILED_MS, DEFAULTS.cache.ttl.failedMs),
    relatedMs: readPositiveInt('CACHE_TTL_RELATED_MS', env.CACHE_TTL_RELATED_MS, DEFAULTS.cache.ttl.relatedMs),
    domainOkMs: readPositiveInt('CACHE_TTL_DOMAIN_OK_MS', env.CACHE_TTL_DOMAIN_OK_MS, DEFAULTS.cache.ttl.domainOkMs),
    domainNotFoundMs: readPositiveInt(
      'CACHE_TTL_DOMAIN_NOT_FOUND_MS',
      env.CACHE_TTL_DOMAIN_NOT_FOUND_MS,
      DEFAULTS.cache.ttl.domainNotFoundMs,
    ),
    domainErrorMs: readPositiveInt('CACHE_TTL_DOMAIN_ERROR_MS', env.CACHE_TTL_DOMAIN_ERROR_MS, DEFAULTS.cache.ttl.domainErrorMs),
  };

  const config: ResearchConfig = {
    research: {
      market: (env.RESEARCH_MARKET ?? DEFAULTS.research.market).trim(),
      googleHl: (env.GOOGLE_HL ?? DEFAULTS.research.googleHl).trim(),
      googleGl: (env.GOOGLE_GL ?? DEFAULTS.research.googleGl).trim(),
      topN,
    },
    browser: {
      cdpUrl: (env.CDP_URL ?? DEFAULTS.browser.cdpUrl).trim(),
      navigationTimeoutMs: readPositiveNumber(
        'NAVIGATION_TIMEOUT_MS',
        env.NAVIGATION_TIMEOUT_MS,
        DEFAULTS.browser.navigationTimeoutMs,
      ),
      surferWaitTimeoutMs: readPositiveNumber(
        'SURFER_WAIT_MS',
        env.SURFER_WAIT_MS,
        DEFAULTS.browser.surferWaitTimeoutMs,
      ),
      surferPreflightTimeoutMs: readPositiveNumber(
        'SURFER_PREFLIGHT_TIMEOUT_MS',
        env.SURFER_PREFLIGHT_TIMEOUT_MS,
        DEFAULTS.browser.surferPreflightTimeoutMs,
      ),
      surferWidgetSelector: (
        env.SURFER_WIDGET_SELECTOR ?? DEFAULTS.browser.surferWidgetSelector
      ).trim(),
    },
    retry,
    circuitBreaker,
    cache: {
      path: (env.CACHE_DB_PATH ?? DEFAULTS.cache.path).trim(),
      ttl: cacheTtl,
    },
  };

  if (!config.research.market || !config.research.googleHl || !config.research.googleGl) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'RESEARCH_MARKET, GOOGLE_HL and GOOGLE_GL must not be empty.',
    );
  }

  if (!config.browser.cdpUrl) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'CDP_URL must not be empty.');
  }

  if (!config.browser.surferWidgetSelector) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'SURFER_WIDGET_SELECTOR must not be empty.');
  }

  if (!config.cache.path) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'CACHE_DB_PATH must not be empty.');
  }

  return config;
}