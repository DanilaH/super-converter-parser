import { ResearchError } from '../shared/errors.js';

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
    surferWaitTimeoutMs: 30_000,
    surferWidgetSelector: '.surfer-main-keyword-widget',
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResearchConfig {
  const topN = readPositiveNumber('TOP_N', env.TOP_N, DEFAULTS.research.topN);
  if (topN < 1 || topN > 30) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid TOP_N: expected a number between 1 and 30, got "${topN}".`,
    );
  }

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