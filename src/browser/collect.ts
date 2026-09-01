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

// Structured related-keyword outcome. The status is independent of the main
// Surfer/Google parse result: a broken related widget is reported as 'error'
// even when the primary collection succeeded, and a successful primary
// collection with a broken related widget still preserves the related 'error'.
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

export type BrowserCollectionTiming = {
  kind: 'primary' | 'related_only';
  keyword: string;
  normalizedKeyword: string;
  isRoot: boolean;
  outcome: 'completed' | 'partial' | 'failed' | 'paused';
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

export async function collectKeyword(
  context: BrowserContext,
  config: ResearchConfig,
  keyword: KeywordRecord,
  debugRoot: string,
  signal: CancellationSignal = NEVER_CANCELLED,
  timingSink?: BrowserCollectionTimingSink,
): Promise<CollectionResult> {
  const totalStartedAt = Date.now();
  const pageCreateStartedAt = Date.now();
  const page = await context.newPage();
  const pageCreateMs = Date.now() - pageCreateStartedAt;
  const isRoot = !keyword.sources.some((source) => source.type === 'surfer_related');
  let outcome: BrowserCollectionTiming['outcome'] = 'failed';
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
          const solved = await pauseForManualCaptcha(page, signal);
          if (!solved) {
            // The run was cancelled (Ctrl+C) while the CAPTCHA was pending. Do not
            // pretend the CAPTCHA was solved: abort collection so the engine leaves
            // the active keyword resumable instead of committing a false result.
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

    const errors: ComponentError[] = [];
    let volume: number | null = null;
    let cpc: number | null = null;
    let serpRows: SerpResult[] = [];
    let serpStatus: SerpObservationStatus = 'not_fetched';
    let serpError: ComponentError | null = null;

    const mainSurferStartedAt = Date.now();
    try {
      try {
        const surfer = await readSurferResult(
          page,
          config.browser.surferWidgetSelector,
          config.browser.surferWaitTimeoutMs,
        );
        volume = surfer.volume;
        cpc = surfer.cpc;
      } catch (error) {
        const { code, message } = toComponentError(error, 'SURFER_PARSE_ERROR');
        errors.push({ code, message });
      }
    } finally {
      mainSurferMs = Date.now() - mainSurferStartedAt;
    }

    // The related-keyword reader runs for every root/seed keyword regardless of
    // expansion.enabled. --expand only controls whether observed rows are queued
    // for depth-one Google lookups (handled by the engine). Expanded
    // (surfer_related) keywords are collected but never expanded further, so
    // re-reading their related list would be wasted browser work.
    let related: SurferRelatedOutcome = { status: 'not_attempted', error: null, rows: [] };
    let relatedParserError: ComponentError | null = null;
    if (isRoot) {
      const relatedStartedAt = Date.now();
      try {
        // The related-keywords widget can mount lazily after the main Surfer
        // widget; scroll the results so Surfer renders it before we read.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
        await page.waitForTimeout(1000);
        try {
          const parsed = await readSurferRelated(
            page,
            config.browser.surferRelatedWidgetSelector,
            config.browser.surferWaitTimeoutMs,
            config.browser.surferRelatedMissingWidgetTimeoutMs,
          );
          // null means the related widget was genuinely absent (fast-failed after
          // the bounded missing-widget timeout) — classify as 'error', never as
          // 'empty'. Only a present widget with zero rows is 'empty'.
          related =
            parsed === null
              ? { status: 'error', error: 'SURFER_RELATED_WIDGET_MISSING', rows: [] }
              : parsed.length > 0
                ? { status: 'ok', error: null, rows: parsed }
                : { status: 'empty', error: null, rows: [] };
        } catch (error) {
          // Related-keyword observation is optional enrichment: a missing/broken
          // widget must not downgrade an otherwise-successful keyword. The error
          // is preserved in the structured related outcome for traceability.
          const { code, message } = toComponentError(error, 'SURFER_RELATED_PARSE_ERROR');
          related = { status: 'error', error: code, rows: [] };
          relatedParserError = { code, message };
        }
      } finally {
        relatedSurferMs = Date.now() - relatedStartedAt;
      }
    }

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
    const geoWarning =
      detectedLocation !== null && !geoMatchesMarket(config.research.market, detectedLocation);

    const status = errors.length === 0 ? 'completed' : volume !== null || serpRows.length > 0 ? 'partial' : 'failed';
    outcome = status;
    const firstError = errors[0] ?? null;

    if (firstError && isParserErrorCode(firstError.code)) {
      debugArtifactPath = await saveParserFailureArtifacts(
        page,
        config,
        debugRoot,
        keywordSlug(keyword.normalizedKeyword),
        buildParserFailureContext(
          keyword.normalizedKeyword,
          pageUrl,
          config,
          firstError.code,
          firstError.message,
        ),
      );
    }

    // The aggregate keyword error preserves the first failing component for
    // backward compatibility, but the Google SERP error is independently
    // persisted below. When Surfer failed first, retain a Google-specific debug
    // context as well instead of losing the second parser failure completely.
    if (serpError && serpError !== firstError && isParserErrorCode(serpError.code)) {
      debugArtifactPath = await saveParserFailureArtifacts(
        page,
        config,
        debugRoot,
        `${keywordSlug(keyword.normalizedKeyword)}-serp`,
        buildParserFailureContext(
          keyword.normalizedKeyword,
          pageUrl,
          config,
          serpError.code,
          serpError.message,
        ),
      );
    }

    if (relatedParserError && isParserErrorCode(relatedParserError.code)) {
      debugArtifactPath = await saveParserFailureArtifacts(
        page,
        config,
        debugRoot,
        `${keywordSlug(keyword.normalizedKeyword)}-related`,
        buildParserFailureContext(
          keyword.normalizedKeyword,
          pageUrl,
          config,
          relatedParserError.code,
          relatedParserError.message,
        ),
      );
    }

    const fetchedAt = new Date().toISOString();
    const record: KeywordRecord = {
      ...keyword,
      status,
      surfer:
        volume !== null
          ? {
              volume,
              cpc,
              market: config.research.market,
              fetchedAt,
            }
          : null,
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
    // A cancellation (Ctrl+C) must propagate to the engine so it can leave the
    // active keyword resumable and record the run as paused. It must not be
    // swallowed into a false 'failed' result.
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
    timingSink?.({
      kind: 'primary',
      keyword: keyword.keyword,
      normalizedKeyword: keyword.normalizedKeyword,
      isRoot,
      outcome,
      pageCreateMs,
      navigationMs,
      captchaMs,
      mainSurferMs,
      relatedSurferMs,
      serpParseMs,
      locationParseMs,
      totalMs: Date.now() - totalStartedAt,
    });
    await page.close().catch(() => undefined);
  }
}

// Refreshes only the optional related-keyword enrichment for a keyword whose
// primary keyword/SERP result is already a cache hit. The cached primary result
// remains authoritative and is never overwritten by this browser visit.
export async function collectRelatedKeyword(
  context: BrowserContext,
  config: ResearchConfig,
  keyword: KeywordRecord,
  debugRoot: string,
  signal: CancellationSignal = NEVER_CANCELLED,
  timingSink?: BrowserCollectionTimingSink,
): Promise<RelatedCollectionResult> {
  const totalStartedAt = Date.now();
  const pageCreateStartedAt = Date.now();
  const page = await context.newPage();
  const pageCreateMs = Date.now() - pageCreateStartedAt;
  const isRoot = !keyword.sources.some((source) => source.type === 'surfer_related');
  let outcome: BrowserCollectionTiming['outcome'] = 'failed';
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

    const relatedStartedAt = Date.now();
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
      await page.waitForTimeout(1000);
      try {
        const rows = await readSurferRelated(
          page,
          config.browser.surferRelatedWidgetSelector,
          config.browser.surferWaitTimeoutMs,
          config.browser.surferRelatedMissingWidgetTimeoutMs,
        );
        // null = widget genuinely absent → 'error', never 'empty'.
        const related: SurferRelatedOutcome = rows === null
          ? { status: 'error', error: 'SURFER_RELATED_WIDGET_MISSING', rows: [] }
          : rows.length > 0
            ? { status: 'ok', error: null, rows }
            : { status: 'empty', error: null, rows: [] };
        outcome = related.status === 'ok' || related.status === 'empty' ? 'completed' : 'partial';
        return { related, debugArtifactPath: null };
      } catch (error) {
        if (error instanceof ResearchError && error.code === 'RUN_PAUSED') {
          outcome = 'paused';
          throw error;
        }
        const { code, message } = toComponentError(error, 'SURFER_RELATED_PARSE_ERROR');
        const debugArtifactPath = isParserErrorCode(code)
          ? await saveParserFailureArtifacts(
              page,
              config,
              debugRoot,
              `${keywordSlug(keyword.normalizedKeyword)}-related`,
              buildParserFailureContext(
                keyword.normalizedKeyword,
                pageUrl,
                config,
                code,
                message,
              ),
            )
          : null;
        outcome = 'partial';
        return {
          related: { status: 'error', error: code, rows: [] },
          debugArtifactPath,
        };
      }
    } finally {
      relatedSurferMs = Date.now() - relatedStartedAt;
    }
  } catch (error) {
    // Navigation/CAPTCHA failures happen before the related reader has a
    // truthful result, so they must not be cached as a genuine empty list.
    // A cancellation (Ctrl+C) must propagate to the engine so it can leave the
    // active keyword resumable and record the run as paused.
    if (error instanceof ResearchError && error.code === 'RUN_PAUSED') {
      outcome = 'paused';
      throw error;
    }
    outcome = 'failed';
    return {
      related: { status: 'not_attempted', error: null, rows: [] },
      debugArtifactPath: null,
    };
  } finally {
    timingSink?.({
      kind: 'related_only',
      keyword: keyword.keyword,
      normalizedKeyword: keyword.normalizedKeyword,
      isRoot,
      outcome,
      pageCreateMs,
      navigationMs,
      captchaMs,
      mainSurferMs: null,
      relatedSurferMs,
      serpParseMs: null,
      locationParseMs: null,
      totalMs: Date.now() - totalStartedAt,
    });
    await page.close().catch(() => undefined);
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

function toComponentError(error: unknown, fallbackCode: ResearchErrorCode): ComponentError {
  if (error instanceof ResearchError) {
    return { code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: fallbackCode, message };
}
