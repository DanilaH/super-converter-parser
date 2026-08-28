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
    surferRelatedWidgetSelector: string;
    surferRelatedMissingWidgetTimeoutMs: number;
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
  expansion: {
    enabled: boolean;
    depth: number;
    maxCandidatesPerKeyword: number;
    minOverlap: number;
    minVolume: number;
  };
  cache: {
    path: string;
    ttl: {
      completedMs: number;
      partialMs: number;
      failedMs: number;
      relatedMs: number;
      relatedErrorMs: number;
      domainOkMs: number;
      domainNotFoundMs: number;
      domainErrorMs: number;
      domainAge: {
        rdapOkMs: number;
        rdapNotFoundMs: number;
        rdapUnsupportedMs: number;
        rdapErrorMs: number;
        firstSeenOkMs: number;
        firstSeenErrorMs: number;
        firstSeenUnavailableMs: number;
      };
      suggestionOkMs: number;
      suggestionEmptyMs: number;
      suggestionErrorMs: number;
    };
  };
  ahrefs: {
    endpoint: string;
    rateLimitMinDelayMs: number;
    rateLimitMaxDelayMs: number;
    timeoutMs: number;
    requireAhrefs: boolean;
  };
  rdap: {
    bootstrapBase: string;
    bootstrapFile: string;
    bootstrapTtlMs: number;
    queryTimeoutMs: number;
    perHostMinDelayMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  firstSeen: {
    provider: string;
    endpoint: string;
    timeoutMs: number;
    minDelayMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  // Centralized DR classification thresholds for candidate scoring. See
  // SCORING.md: very weak < veryWeakMax <= weak < weakMax <= neutral
  // < strongMin <= strong < strongMax <= very strong.
  scoring: {
    drThresholds: {
      veryWeakMax: number;
      weakMax: number;
      strongMin: number;
      strongMax: number;
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
    cdpUrl: 'http://127.0.0.1:9333',
    navigationTimeoutMs: 60_000,
    surferWaitTimeoutMs: 60_000,
    surferPreflightTimeoutMs: 60_000,
      surferWidgetSelector: SURFER_MARKERS.mainWidget,
      surferRelatedWidgetSelector: SURFER_MARKERS.relatedWidget,
      surferRelatedMissingWidgetTimeoutMs: 5000,
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
  expansion: {
    enabled: false,
    depth: 1,
    maxCandidatesPerKeyword: 20,
    minOverlap: 0,
    minVolume: 0,
  },
  cache: {
    path: 'data/cache/cache.sqlite',
    ttl: {
      completedMs: 7 * 24 * 60 * 60 * 1000,
      partialMs: 6 * 60 * 60 * 1000,
      failedMs: 60 * 60 * 1000,
      relatedMs: 7 * 24 * 60 * 60 * 1000,
      relatedErrorMs: 60 * 60 * 1000,
      domainOkMs: 30 * 24 * 60 * 60 * 1000,
      domainNotFoundMs: 30 * 24 * 60 * 60 * 1000,
      domainErrorMs: 60 * 60 * 1000,
      domainAge: {
        rdapOkMs: 180 * 24 * 60 * 60 * 1000,
        rdapNotFoundMs: 30 * 24 * 60 * 60 * 1000,
        rdapUnsupportedMs: 30 * 24 * 60 * 60 * 1000,
        rdapErrorMs: 60 * 60 * 1000,
        firstSeenOkMs: 30 * 24 * 60 * 60 * 1000,
        firstSeenErrorMs: 60 * 60 * 1000,
        firstSeenUnavailableMs: 24 * 60 * 60 * 1000,
      },
      suggestionOkMs: 7 * 24 * 60 * 60 * 1000,
      suggestionEmptyMs: 7 * 24 * 60 * 60 * 1000,
      suggestionErrorMs: 60 * 60 * 1000,
    },
  },
  ahrefs: {
    endpoint: 'https://api.ahrefs.com/v3/public/domain-rating-free',
    rateLimitMinDelayMs: 1000,
    rateLimitMaxDelayMs: 10_000,
    timeoutMs: 15_000,
    requireAhrefs: false,
  },
  rdap: {
    bootstrapBase: 'https://data.iana.org/rdap/',
    bootstrapFile: 'dns.json',
    bootstrapTtlMs: 24 * 60 * 60 * 1000,
    queryTimeoutMs: 15_000,
    perHostMinDelayMs: 500,
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 15_000,
  },
  firstSeen: {
    provider: '',
    endpoint: '',
    timeoutMs: 15_000,
    minDelayMs: 1_000,
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 15_000,
  },
  scoring: {
    drThresholds: {
      veryWeakMax: 10,
      weakMax: 30,
      strongMin: 60,
      strongMax: 75,
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

function readBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new ResearchError(
    'INPUT_SCHEMA_ERROR',
    `Invalid ${name}: expected true/false, got "${value}".`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResearchConfig {
  const topN = readPositiveInt('TOP_N', env.TOP_N, DEFAULTS.research.topN);
  if (topN > 30) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid TOP_N: expected an integer between 1 and 30, got "${topN}".`,
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

  const expansion = {
    enabled: readBoolean('EXPANSION_ENABLED', env.EXPANSION_ENABLED, DEFAULTS.expansion.enabled),
    depth: readPositiveInt('EXPANSION_DEPTH', env.EXPANSION_DEPTH, DEFAULTS.expansion.depth),
    maxCandidatesPerKeyword: readPositiveInt(
      'EXPANSION_MAX_CANDIDATES',
      env.EXPANSION_MAX_CANDIDATES,
      DEFAULTS.expansion.maxCandidatesPerKeyword,
    ),
    minOverlap: readPositiveNumber('EXPANSION_MIN_OVERLAP', env.EXPANSION_MIN_OVERLAP, DEFAULTS.expansion.minOverlap),
    minVolume: readPositiveNumber('EXPANSION_MIN_VOLUME', env.EXPANSION_MIN_VOLUME, DEFAULTS.expansion.minVolume),
  };

  if (expansion.depth !== 1) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid EXPANSION_DEPTH: only depth 1 is currently supported, got "${expansion.depth}".`,
    );
  }

  const cacheTtl = {
    completedMs: readPositiveInt('CACHE_TTL_COMPLETED_MS', env.CACHE_TTL_COMPLETED_MS, DEFAULTS.cache.ttl.completedMs),
    partialMs: readPositiveInt('CACHE_TTL_PARTIAL_MS', env.CACHE_TTL_PARTIAL_MS, DEFAULTS.cache.ttl.partialMs),
    failedMs: readPositiveInt('CACHE_TTL_FAILED_MS', env.CACHE_TTL_FAILED_MS, DEFAULTS.cache.ttl.failedMs),
    relatedMs: readPositiveInt('CACHE_TTL_RELATED_MS', env.CACHE_TTL_RELATED_MS, DEFAULTS.cache.ttl.relatedMs),
    relatedErrorMs: readPositiveInt(
      'CACHE_TTL_RELATED_ERROR_MS',
      env.CACHE_TTL_RELATED_ERROR_MS,
      DEFAULTS.cache.ttl.relatedErrorMs,
    ),
    domainOkMs: readPositiveInt('CACHE_TTL_DOMAIN_OK_MS', env.CACHE_TTL_DOMAIN_OK_MS, DEFAULTS.cache.ttl.domainOkMs),
    domainNotFoundMs: readPositiveInt(
      'CACHE_TTL_DOMAIN_NOT_FOUND_MS',
      env.CACHE_TTL_DOMAIN_NOT_FOUND_MS,
      DEFAULTS.cache.ttl.domainNotFoundMs,
    ),
    domainErrorMs: readPositiveInt('CACHE_TTL_DOMAIN_ERROR_MS', env.CACHE_TTL_DOMAIN_ERROR_MS, DEFAULTS.cache.ttl.domainErrorMs),
    suggestionOkMs: readPositiveInt('CACHE_TTL_SUGGESTION_OK_MS', env.CACHE_TTL_SUGGESTION_OK_MS, DEFAULTS.cache.ttl.suggestionOkMs),
    suggestionEmptyMs: readPositiveInt(
      'CACHE_TTL_SUGGESTION_EMPTY_MS',
      env.CACHE_TTL_SUGGESTION_EMPTY_MS,
      DEFAULTS.cache.ttl.suggestionEmptyMs,
    ),
    suggestionErrorMs: readPositiveInt(
      'CACHE_TTL_SUGGESTION_ERROR_MS',
      env.CACHE_TTL_SUGGESTION_ERROR_MS,
      DEFAULTS.cache.ttl.suggestionErrorMs,
    ),
    domainAge: {
      rdapOkMs: readPositiveInt('CACHE_TTL_RDAP_OK_MS', env.CACHE_TTL_RDAP_OK_MS, DEFAULTS.cache.ttl.domainAge.rdapOkMs),
      rdapNotFoundMs: readPositiveInt('CACHE_TTL_RDAP_NOT_FOUND_MS', env.CACHE_TTL_RDAP_NOT_FOUND_MS, DEFAULTS.cache.ttl.domainAge.rdapNotFoundMs),
      rdapUnsupportedMs: readPositiveInt('CACHE_TTL_RDAP_UNSUPPORTED_MS', env.CACHE_TTL_RDAP_UNSUPPORTED_MS, DEFAULTS.cache.ttl.domainAge.rdapUnsupportedMs),
      rdapErrorMs: readPositiveInt('CACHE_TTL_RDAP_ERROR_MS', env.CACHE_TTL_RDAP_ERROR_MS, DEFAULTS.cache.ttl.domainAge.rdapErrorMs),
      firstSeenOkMs: readPositiveInt('CACHE_TTL_FIRST_SEEN_OK_MS', env.CACHE_TTL_FIRST_SEEN_OK_MS, DEFAULTS.cache.ttl.domainAge.firstSeenOkMs),
      firstSeenErrorMs: readPositiveInt('CACHE_TTL_FIRST_SEEN_ERROR_MS', env.CACHE_TTL_FIRST_SEEN_ERROR_MS, DEFAULTS.cache.ttl.domainAge.firstSeenErrorMs),
      firstSeenUnavailableMs: readPositiveInt('CACHE_TTL_FIRST_SEEN_UNAVAILABLE_MS', env.CACHE_TTL_FIRST_SEEN_UNAVAILABLE_MS, DEFAULTS.cache.ttl.domainAge.firstSeenUnavailableMs),
    },
  };

  const drThresholds = {
    veryWeakMax: readPositiveNumber(
      'SCORING_DR_VERY_WEAK_MAX',
      env.SCORING_DR_VERY_WEAK_MAX,
      DEFAULTS.scoring.drThresholds.veryWeakMax,
    ),
    weakMax: readPositiveNumber(
      'SCORING_DR_WEAK_MAX',
      env.SCORING_DR_WEAK_MAX,
      DEFAULTS.scoring.drThresholds.weakMax,
    ),
    strongMin: readPositiveNumber(
      'SCORING_DR_STRONG_MIN',
      env.SCORING_DR_STRONG_MIN,
      DEFAULTS.scoring.drThresholds.strongMin,
    ),
    strongMax: readPositiveNumber(
      'SCORING_DR_STRONG_MAX',
      env.SCORING_DR_STRONG_MAX,
      DEFAULTS.scoring.drThresholds.strongMax,
    ),
  };
  if (drThresholds.veryWeakMax >= drThresholds.weakMax) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid SCORING_DR_VERY_WEAK_MAX: must be less than SCORING_DR_WEAK_MAX (${drThresholds.weakMax}), got ${drThresholds.veryWeakMax}.`,
    );
  }
  if (drThresholds.weakMax >= drThresholds.strongMin) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid SCORING_DR_WEAK_MAX: must be less than SCORING_DR_STRONG_MIN (${drThresholds.strongMin}), got ${drThresholds.weakMax}.`,
    );
  }
  if (drThresholds.strongMin >= drThresholds.strongMax) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid SCORING_DR_STRONG_MIN: must be less than SCORING_DR_STRONG_MAX (${drThresholds.strongMax}), got ${drThresholds.strongMin}.`,
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
      surferPreflightTimeoutMs: readPositiveNumber(
        'SURFER_PREFLIGHT_TIMEOUT_MS',
        env.SURFER_PREFLIGHT_TIMEOUT_MS,
        DEFAULTS.browser.surferPreflightTimeoutMs,
      ),
      surferWidgetSelector: (
        env.SURFER_WIDGET_SELECTOR ?? DEFAULTS.browser.surferWidgetSelector
      ).trim(),
      surferRelatedWidgetSelector: (
        env.SURFER_RELATED_WIDGET_SELECTOR ?? DEFAULTS.browser.surferRelatedWidgetSelector
      ).trim(),
      surferRelatedMissingWidgetTimeoutMs: readPositiveNumber(
        'SURFER_RELATED_MISSING_WIDGET_TIMEOUT_MS',
        env.SURFER_RELATED_MISSING_WIDGET_TIMEOUT_MS,
        DEFAULTS.browser.surferRelatedMissingWidgetTimeoutMs,
      ),
    },
    retry,
    circuitBreaker,
    expansion,
    ahrefs: {
      endpoint: (env.AHREFS_ENDPOINT ?? DEFAULTS.ahrefs.endpoint).trim(),
      rateLimitMinDelayMs: readPositiveNumber(
        'AHREFS_MIN_DELAY_MS',
        env.AHREFS_MIN_DELAY_MS,
        DEFAULTS.ahrefs.rateLimitMinDelayMs,
      ),
      rateLimitMaxDelayMs: readPositiveNumber(
        'AHREFS_MAX_DELAY_MS',
        env.AHREFS_MAX_DELAY_MS,
        DEFAULTS.ahrefs.rateLimitMaxDelayMs,
      ),
      timeoutMs: readPositiveNumber('AHREFS_TIMEOUT_MS', env.AHREFS_TIMEOUT_MS, DEFAULTS.ahrefs.timeoutMs),
      requireAhrefs: readBoolean('REQUIRE_AHREFS', env.REQUIRE_AHREFS, DEFAULTS.ahrefs.requireAhrefs),
    },
    rdap: {
      bootstrapBase: (env.RDAP_BOOTSTRAP_BASE ?? DEFAULTS.rdap.bootstrapBase).trim(),
      bootstrapFile: (env.RDAP_BOOTSTRAP_FILE ?? DEFAULTS.rdap.bootstrapFile).trim(),
      bootstrapTtlMs: readPositiveInt('RDAP_BOOTSTRAP_TTL_MS', env.RDAP_BOOTSTRAP_TTL_MS, DEFAULTS.rdap.bootstrapTtlMs),
      queryTimeoutMs: readPositiveInt('RDAP_QUERY_TIMEOUT_MS', env.RDAP_QUERY_TIMEOUT_MS, DEFAULTS.rdap.queryTimeoutMs),
      perHostMinDelayMs: readPositiveInt('RDAP_PER_HOST_MIN_DELAY_MS', env.RDAP_PER_HOST_MIN_DELAY_MS, DEFAULTS.rdap.perHostMinDelayMs),
      maxAttempts: readPositiveInt('RDAP_MAX_ATTEMPTS', env.RDAP_MAX_ATTEMPTS, DEFAULTS.rdap.maxAttempts),
      baseDelayMs: readPositiveNumber('RDAP_BASE_DELAY_MS', env.RDAP_BASE_DELAY_MS, DEFAULTS.rdap.baseDelayMs),
      maxDelayMs: readPositiveNumber('RDAP_MAX_DELAY_MS', env.RDAP_MAX_DELAY_MS, DEFAULTS.rdap.maxDelayMs),
    },
    firstSeen: {
      provider: (env.FIRST_SEEN_PROVIDER ?? '').trim().toLowerCase(),
      endpoint: (env.FIRST_SEEN_ENDPOINT ?? '').trim(),
      timeoutMs: readPositiveInt('FIRST_SEEN_TIMEOUT_MS', env.FIRST_SEEN_TIMEOUT_MS, DEFAULTS.firstSeen.timeoutMs),
      minDelayMs: readPositiveInt('FIRST_SEEN_MIN_DELAY_MS', env.FIRST_SEEN_MIN_DELAY_MS, DEFAULTS.firstSeen.minDelayMs),
      maxAttempts: readPositiveInt('FIRST_SEEN_MAX_ATTEMPTS', env.FIRST_SEEN_MAX_ATTEMPTS, DEFAULTS.firstSeen.maxAttempts),
      baseDelayMs: readPositiveNumber('FIRST_SEEN_BASE_DELAY_MS', env.FIRST_SEEN_BASE_DELAY_MS, DEFAULTS.firstSeen.baseDelayMs),
      maxDelayMs: readPositiveNumber('FIRST_SEEN_MAX_DELAY_MS', env.FIRST_SEEN_MAX_DELAY_MS, DEFAULTS.firstSeen.maxDelayMs),
    },
    scoring: {
      drThresholds,
    },
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

  if (!config.browser.surferRelatedWidgetSelector) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'SURFER_RELATED_WIDGET_SELECTOR must not be empty.',
    );
  }

  if (!config.cache.path) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'CACHE_DB_PATH must not be empty.');
  }

  if (!config.rdap.bootstrapBase) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'RDAP_BOOTSTRAP_BASE must not be empty.');
  }

  if (!config.rdap.bootstrapFile) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'RDAP_BOOTSTRAP_FILE must not be empty.');
  }

  if (config.firstSeen.provider && !['wayback'].includes(config.firstSeen.provider)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `FIRST_SEEN_PROVIDER must be 'wayback' or blank (unconfigured); got "${config.firstSeen.provider}".`,
    );
  }

  if (config.firstSeen.provider === 'wayback') {
    if (config.firstSeen.endpoint && !isValidUrl(config.firstSeen.endpoint)) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', 'FIRST_SEEN_ENDPOINT must be a valid URL when set.');
    }
  }

  return config;
}

function isValidUrl(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
}