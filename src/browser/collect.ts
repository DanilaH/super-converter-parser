import type { BrowserContext, Page } from 'playwright-core';
import type { ResearchConfig } from '../config/config.js';
import { ResearchError, type ResearchErrorCode } from '../shared/errors.js';
import { readSurferResult } from '../surfer/parser.js';
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
import type { KeywordRecord } from '../runs/run.js';
import { pauseForManualCaptcha, waitForManualCaptcha } from './captcha.js';
import {
  buildParserFailureContext,
  isParserErrorCode,
  saveParserFailureArtifacts,
} from '../diagnostics/artifacts.js';
import { keywordSlug } from '../runs/run.js';

export type CollectionResult = {
  record: KeywordRecord;
  serpRows: SerpResult[];
  debugArtifactPath: string | null;
};

type ComponentError = {
  code: ResearchErrorCode;
  message: string;
};

export async function collectKeyword(
  context: BrowserContext,
  config: ResearchConfig,
  keyword: KeywordRecord,
  debugRoot: string,
): Promise<CollectionResult> {
  const page = await context.newPage();
  let pageUrl = '';
  let debugArtifactPath: string | null = null;

  try {
    const searchUrl = buildSearchUrl(config, keyword.keyword);
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.navigationTimeoutMs,
    });
    pageUrl = page.url();

    try {
      await waitForManualCaptcha(page);
    } catch (error) {
      if (error instanceof ResearchError && error.code === 'CAPTCHA_REQUIRED') {
        await pauseForManualCaptcha(page);
      } else {
        throw error;
      }
    }

    const errors: ComponentError[] = [];
    let volume: number | null = null;
    let cpc: number | null = null;
    let serpRows: SerpResult[] = [];

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
      }
    } catch (error) {
      const { code, message } = toComponentError(error, 'GOOGLE_SERP_PARSE_ERROR');
      errors.push({ code, message });
    }

    const detectedLocation = await readDetectedLocation(page);
    const geoWarning =
      detectedLocation !== null && !geoMatchesMarket(config.research.market, detectedLocation);

    const status = errors.length === 0 ? 'completed' : volume !== null || serpRows.length > 0 ? 'partial' : 'failed';
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
      },
      error: firstError ? { code: firstError.code, message: firstError.message } : null,
    };

    return { record, serpRows, debugArtifactPath };
  } catch (error) {
    const { code, message } = toComponentError(error, 'GOOGLE_UNAVAILABLE');

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
      },
      error: { code, message },
    };

    return { record, serpRows: [], debugArtifactPath: null };
  } finally {
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