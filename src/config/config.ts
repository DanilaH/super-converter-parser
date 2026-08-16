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
      surferWidgetSelector: (
        env.SURFER_WIDGET_SELECTOR ?? DEFAULTS.browser.surferWidgetSelector
      ).trim(),
    },
    retry,
    circuitBreaker,
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

  return config;
}