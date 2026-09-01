import type { BrowserContext, Page } from 'playwright-core';
import type { ResearchConfig } from '../config/config.js';
import { ResearchError, type ResearchErrorCode } from '../shared/errors.js';
import { readSurferResult, readSurferRelated, type SurferRelatedKeyword } from '../surfer/parser.js';
import {
  BODY_TEXT_SCRIPT,
  buildOrganicResults,
  buildSearchUrl,
  detectGoogleLocationFromText,
  geoMatchesMarket,
  GOOGLE_NO_RESULTS_SCRIPT,
  LOCATION_EXTRACT_SCRIPT,
  ORGANIC_EXTRACT_SCRIPT,
  type SerpResult,
} from '../google/serp.js';
import type { KeywordRecord, SerpObservationStatus } from '../runs/run.js';
import {
  pauseForManualCaptcha,
  waitForManualCaptcha,
  type CancellationSignal,
  NEVER_CANCELLED,
} from './captcha.js';
import {
  buildParserFailureContext,
  isParserErrorCode,
  saveParserFailureArtifacts,
} from '../diagnostics/artifacts.js';
import { keywordSlug } from '../runs/run.js';
import { GoogleLegacyCadencePacer } from './googlePacing.js';

export type SurferRelatedOutcome = {
  status: 'not_attempted' | 'ok' | 'empty' | 'error';
  error: string | null;
  rows: SurferRelatedKeyword[];
};

export type CollectionResult = {
  record: KeywordRecord;
  serpRows: SerpResult[];
  related: SurferRelatedOutcome;
  debugArtifactPath: string | null;
};

export type RelatedCollectionResult = {
  related: SurferRelatedOutcome;
  debugArtifactPath: string | null;
};

type ComponentError = {
  code: ResearchErrorCode;
  message: string;
};

type MainSurferComponent = {
  volume: number | null;
  cpc: number | null;
  error: ComponentError | null;
  durationMs: number;
};

type RelatedSurferComponent = {
  related: SurferRelatedOutcome;
  parserError: ComponentError | null;
  durationMs: number;
};

export type BrowserCollectionTiming = {
  kind: 'primary' | 'related_only';
  keyword: string;
  normalizedKeyword: string;
  isRoot: boolean;
  outcome: 'completed' | 'partial' | 'failed' | 'paused';
  captchaEncountered: boolean;
  relatedOutcome: SurferRelatedOutcome['status'] | null;
  googlePacingMs: number;
  pageCreateMs: number;
  navigationMs: number | null;
  captchaMs: number | null;
  mainSurferMs: number | null;
  relatedSurferMs: number | null;
  serpParseMs: number | null;
  locationParseMs: number | null;
  totalMs: number;
};

export type BrowserCollectionTimingSink = (timing: BrowserCollectionTiming) => void;

const GOOGLE_CADENCE_PACERS = new WeakMap<BrowserContext, GoogleLegacyCadencePacer>();

export async function collectKeyword(
  context: BrowserContext,
  config: ResearchConfig,
  keyword: KeywordRecord,
  debugRoot: string,
  signal: CancellationSignal = NEVER_CANCELLED,
  timingSink?: BrowserCollectionTimingSink,
): Promise<CollectionResult> {
  const pacer = getGoogleCadencePacer(context);
  const googlePacingMs = await pacer.wait({ now: Date.now, sleep });
  const totalStartedAt = Date.now();
  const pageCreateStartedAt = Date.now();
  const page = await context.newPage();
  const pageCreateMs = Date.now() - pageCreateStartedAt;
  const isRoot = !keyword.sources.some((source) => source.type === 'surfer_related');
  let outcome: BrowserCollectionTiming['outcome'] = 'failed';
  let captchaEncountered = false;
  let relatedOutcomeForTiming: SurferRelatedOutcome['status'] | null = null;
  let navigationMs: number | null = null;
  let captchaMs: number | null = null;
  let mainSurferMs: number | null = null;
  let relatedSurferMs: number | null = null;
  let serpParseMs: number | null = null;
  let locationParseMs: number | null = null;
  let pageUrl = '';
  let debugArtifactPath: string | null = null;

  try {
    const searchUrl = buildSearchUrl(config, keyword.keyword);
    const navigationStartedAt = Date.now();
    try {
      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.browser.navigationTimeoutMs,
      });
    } finally {
      navigationMs = Date.now() - navigationStartedAt;
    }
    pageUrl = page.url();

    const captchaStartedAt = Date.now();
    try {
      try {
        await waitForManualCaptcha(page);
      } catch (error) {
        if (error instanceof ResearchError && error.code === 'CAPTCHA_REQUIRED') {
          captchaEncountered = true;
          const solved = await pauseForManualCaptcha(page, signal);
          if (!solved) {
            throw new ResearchError(
              'RUN_PAUSED',
              'Collection cancelled while a CAPTCHA was pending; active keyword left resumable.',
            );
          }
        } else {
          throw error;
        }
      }
    } finally {
      captchaMs = Date.now() - captchaStartedAt;
    }

    // Main Surfer and Surfer Related are independent observations from the same
    // already-loaded Google page. Start them together so a slow related widget
    // does not add its entire wait after the main widget wait. The context-level
    // pacer above preserves a conservative pre-PERF-B Google navigation cadence.
    const mainSurferTask = collectMainSurferComponent(page, config);
    const relatedSurferTask = isRoot
      ? collectRelatedSurferComponent(page, config)
      : Promise.resolve<RelatedSurferComponent | null>(null);
    const [mainSurfer, relatedComponent] = await Promise.all([mainSurferTask, relatedSurferTask]);

    mainSurferMs = mainSurfer.durationMs;
    relatedSurferMs = relatedComponent?.durationMs ?? null;
    const volume = mainSurfer.volume;
    const cpc = mainSurfer.cpc;
    const related: SurferRelatedOutcome = relatedComponent?.related ?? {
      status: 'not_attempted',
      error: null,
      rows: [],
    };
    relatedOutcomeForTiming = isRoot ? related.status : null;
    const relatedParserError = relatedComponent?.parserError ?? null;

    const errors: ComponentError[] = [];
    if (mainSurfer.error) errors.push(mainSurfer.error);

    let serpRows: SerpResult[] = [];
    let serpStatus: SerpObservationStatus = 'not_fetched';
    let serpError: ComponentError | null = null;

    // Keep SERP parsing after the Surfer observations exactly as before. PERF-B
    // overlaps only Surfer waits; it does not move the Google evidence capture
    // point earlier in the page lifecycle.
    const serpStartedAt = Date.now();
    try {
      try {
        const rawOrganic = (await page.evaluate(ORGANIC_EXTRACT_SCRIPT)) as Array<{
          href: string;
          title: string;
        }>;
        serpRows = buildOrganicResults(rawOrganic, keyword.normalizedKeyword, config.research.topN);
        if (serpRows.length === 0) {
          const noResults = (await page.evaluate(GOOGLE_NO_RESULTS_SCRIPT)) as boolean;
          if (!noResults) {
            throw new ResearchError(
              'GOOGLE_SERP_PARSE_ERROR',
              'Organic SERP extraction returned zero rows while the page is not a zero-result page; the selector may be broken.',
            );
          }
          serpStatus = 'empty';
        } else {
          serpStatus = 'ok';
        }
      } catch (error) {
        serpError = toComponentError(error, 'GOOGLE_SERP_PARSE_ERROR');
        serpStatus = serpError.code === 'GOOGLE_UNAVAILABLE' ? 'fetch_error' : 'parse_error';
        errors.push(serpError);
      }
    } finally {
      serpParseMs = Date.now() - serpStartedAt;
    }

    const locationStartedAt = Date.now();
    const detectedLocation = await readDetectedLocation(page);
    locationParseMs = Date.now() - locationStartedAt;
    const geoWarning = detectedLocation !== null && !geoMatchesMarket(config.research.market, detectedLocation);

    const status = errors.length === 0 ? 'completed' : volume !== null || serpRows.length > 0 ? 'partial' : 'failed';
    outcome = status;
    const firstError = errors[0] ?? null;

    if (firstError && isParserErrorCode(firstError.code)) {
      debugArtifactPath = await saveParserFailureArtifacts(
        page,
        config,
        debugRoot,
        keywordSlug(keyword.normalizedKeyword),
        buildParserFailureContext(keyword.normalizedKeyword, pageUrl, config, firstError.code, firstError.message),
      );
    }

    if (serpError && serpError !== firstError && isParserErrorCode(serpError.code)) {
      debugArtifactPath = await saveParserFailureArtifacts(
        page,
        config,
        debugRoot,
        `${keywordSlug(keyword.normalizedKeyword)}-serp`,
        buildParserFailureContext(keyword.normalizedKeyword, pageUrl, config, serpError.code, serpError.message),
      );
    }

    if (relatedParserError && isParserErrorCode(relatedParserError.code)) {
      debugArtifactPath = await saveParserFailureArtifacts(
        page,
        config,
        debugRoot,
        `${keywordSlug(keyword.normalizedKeyword)}-related`,
        buildParserFailureContext(keyword.normalizedKeyword, pageUrl, config, relatedParserError.code, relatedParserError.message),
      );
    }

    const fetchedAt = new Date().toISOString();
    const record: KeywordRecord = {
      ...keyword,
      status,
      surfer: volume !== null ? { volume, cpc, market: config.research.market, fetchedAt } : null,
      google: {
        hl: config.research.googleHl,
        gl: config.research.googleGl,
        pageUrl,
        detectedLocation,
        geoWarning,
        serpStatus,
        serpError,
      },
      error: firstError ? { code: firstError.code, message: firstError.message } : null,
    };

    return { record, serpRows, related, debugArtifactPath };
  } catch (error) {
    if (error instanceof ResearchError && error.code === 'RUN_PAUSED') {
      outcome = 'paused';
      throw error;
    }
    const { code, message } = toComponentError(error, 'GOOGLE_UNAVAILABLE');
    outcome = 'failed';

    const record: KeywordRecord = {
      ...keyword,
      status: 'failed',
      surfer: null,
      google: {
        hl: config.research.googleHl,
        gl: config.research.googleGl,
        pageUrl,
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'fetch_error',
        serpError: { code, message },
      },
      error: { code, message },
    };

    return {
      record,
      serpRows: [],
      related: { status: 'not_attempted', error: null, rows: [] },
      debugArtifactPath: null,
    };
  } finally {
    const timing: BrowserCollectionTiming = {
      kind: 'primary',
      keyword: keyword.keyword,
      normalizedKeyword: keyword.normalizedKeyword,
      isRoot,
      outcome,
      captchaEncountered,
      relatedOutcome: relatedOutcomeForTiming,
      googlePacingMs,
      pageCreateMs,
      navigationMs,
      captchaMs,
      mainSurferMs,
      relatedSurferMs,
      serpParseMs,
      locationParseMs,
      totalMs: Date.now() - totalStartedAt,
    };
    pacer.observe(timing, Date.now());
    emitTiming(timingSink, timing);
    await page.close().catch(() => undefined);
  }
}

export async function collectRelatedKeyword(
  context: BrowserContext,
  config: ResearchConfig,
  keyword: KeywordRecord,
  debugRoot: string,
  signal: CancellationSignal = NEVER_CANCELLED,
  timingSink?: BrowserCollectionTimingSink,
): Promise<RelatedCollectionResult> {
  const pacer = getGoogleCadencePacer(context);
  const googlePacingMs = await pacer.wait({ now: Date.now, sleep });
  const totalStartedAt = Date.now();
  const pageCreateStartedAt = Date.now();
  const page = await context.newPage();
  const pageCreateMs = Date.now() - pageCreateStartedAt;
  const isRoot = !keyword.sources.some((source) => source.type === 'surfer_related');
  let outcome: BrowserCollectionTiming['outcome'] = 'failed';
  let captchaEncountered = false;
  let relatedOutcomeForTiming: SurferRelatedOutcome['status'] | null = null;
  let navigationMs: number | null = null;
  let captchaMs: number | null = null;
  let relatedSurferMs: number | null = null;
  let pageUrl = '';

  try {
    const navigationStartedAt = Date.now();
    try {
      await page.goto(buildSearchUrl(config, keyword.keyword), {
        waitUntil: 'domcontentloaded',
        timeout: config.browser.navigationTimeoutMs,
      });
    } finally {
      navigationMs = Date.now() - navigationStartedAt;
    }
    pageUrl = page.url();

    const captchaStartedAt = Date.now();
    try {
      try {
        await waitForManualCaptcha(page);
      } catch (error) {
        if (error instanceof ResearchError && error.code === 'CAPTCHA_REQUIRED') {
          captchaEncountered = true;
          const solved = await pauseForManualCaptcha(page, signal);
          if (!solved) {
            throw new ResearchError(
              'RUN_PAUSED',
              'Related collection cancelled while a CAPTCHA was pending; active keyword left resumable.',
            );
          }
        } else {
          throw error;
        }
      }
    } finally {
      captchaMs = Date.now() - captchaStartedAt;
    }

    const relatedComponent = await collectRelatedSurferComponent(page, config);
    relatedSurferMs = relatedComponent.durationMs;
    const related = relatedComponent.related;
    relatedOutcomeForTiming = related.status;

    if (relatedComponent.parserError) {
      const { code, message } = relatedComponent.parserError;
      const debugArtifactPath = isParserErrorCode(code)
        ? await saveParserFailureArtifacts(
            page,
            config,
            debugRoot,
            `${keywordSlug(keyword.normalizedKeyword)}-related`,
            buildParserFailureContext(keyword.normalizedKeyword, pageUrl, config, code, message),
          )
        : null;
      outcome = 'partial';
      return { related, debugArtifactPath };
    }

    outcome = related.status === 'ok' || related.status === 'empty' ? 'completed' : 'partial';
    return { related, debugArtifactPath: null };
  } catch (error) {
    if (error instanceof ResearchError && error.code === 'RUN_PAUSED') {
      outcome = 'paused';
      throw error;
    }
    outcome = 'failed';
    return { related: { status: 'not_attempted', error: null, rows: [] }, debugArtifactPath: null };
  } finally {
    const timing: BrowserCollectionTiming = {
      kind: 'related_only',
      keyword: keyword.keyword,
      normalizedKeyword: keyword.normalizedKeyword,
      isRoot,
      outcome,
      captchaEncountered,
      relatedOutcome: relatedOutcomeForTiming,
      googlePacingMs,
      pageCreateMs,
      navigationMs,
      captchaMs,
      mainSurferMs: null,
      relatedSurferMs,
      serpParseMs: null,
      locationParseMs: null,
      totalMs: Date.now() - totalStartedAt,
    };
    pacer.observe(timing, Date.now());
    emitTiming(timingSink, timing);
    await page.close().catch(() => undefined);
  }
}

async function collectMainSurferComponent(page: Page, config: ResearchConfig): Promise<MainSurferComponent> {
  const startedAt = Date.now();
  try {
    const surfer = await readSurferResult(
      page,
      config.browser.surferWidgetSelector,
      config.browser.surferWaitTimeoutMs,
    );
    return {
      volume: surfer.volume,
      cpc: surfer.cpc,
      error: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      volume: null,
      cpc: null,
      error: toComponentError(error, 'SURFER_PARSE_ERROR'),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function collectRelatedSurferComponent(page: Page, config: ResearchConfig): Promise<RelatedSurferComponent> {
  const startedAt = Date.now();
  try {
    // Scrolling is the lazy-mount trigger. readSurferRelated already polls the
    // widget every 500 ms, so the previous unconditional 1000 ms sleep only
    // delayed the first useful observation and is intentionally removed.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
    const parsed = await readSurferRelated(
      page,
      config.browser.surferRelatedWidgetSelector,
      config.browser.surferWaitTimeoutMs,
      config.browser.surferRelatedMissingWidgetTimeoutMs,
    );
    return {
      related: parsed === null
        ? { status: 'error', error: 'SURFER_RELATED_WIDGET_MISSING', rows: [] }
        : parsed.length > 0
          ? { status: 'ok', error: null, rows: parsed }
          : { status: 'empty', error: null, rows: [] },
      parserError: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const componentError = toComponentError(error, 'SURFER_RELATED_PARSE_ERROR');
    return {
      related: { status: 'error', error: componentError.code, rows: [] },
      parserError: componentError,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function readDetectedLocation(page: Page): Promise<string | null> {
  try {
    const direct = (await page.evaluate(LOCATION_EXTRACT_SCRIPT)) as string | null;
    if (direct) return direct;
    const bodyText = (await page.evaluate(BODY_TEXT_SCRIPT)) as string;
    return detectGoogleLocationFromText(bodyText);
  } catch {
    return null;
  }
}

function getGoogleCadencePacer(context: BrowserContext): GoogleLegacyCadencePacer {
  const existing = GOOGLE_CADENCE_PACERS.get(context);
  if (existing) return existing;
  const created = new GoogleLegacyCadencePacer();
  GOOGLE_CADENCE_PACERS.set(context, created);
  return created;
}

function emitTiming(sink: BrowserCollectionTimingSink | undefined, timing: BrowserCollectionTiming): void {
  try {
    sink?.(timing);
  } catch {
    // Telemetry is observational only and must never change collection semantics.
  }
}

function toComponentError(error: unknown, fallbackCode: ResearchErrorCode): ComponentError {
  if (error instanceof ResearchError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { code: fallbackCode, message };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
