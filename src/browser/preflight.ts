import type { BrowserContext, Page } from 'playwright-core';
import type { ResearchConfig } from '../config/config.js';
import { ResearchError } from '../shared/errors.js';
import { buildSearchUrl, PREFLIGHT_SURFER_MARKER_SCRIPT } from '../google/serp.js';
import { SURFER_MARKERS } from '../surfer/selectors.js';
import { pauseForManualCaptcha, waitForManualCaptcha } from './captcha.js';

const PREFLIGHT_QUERY = 'preflight probe';
const PREFLIGHT_SETTLE_MS = 2_000;

export async function preflightGoogleAndSurfer(
  context: BrowserContext,
  config: ResearchConfig,
): Promise<void> {
  const page = await context.newPage();
  try {
    const searchUrl = buildSearchUrl(config, PREFLIGHT_QUERY);
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.navigationTimeoutMs,
    });

    try {
      await waitForManualCaptcha(page);
    } catch (error) {
      if (error instanceof ResearchError && error.code === 'CAPTCHA_REQUIRED') {
        await pauseForManualCaptcha(page);
      } else {
        throw error;
      }
    }

    await page.waitForTimeout(PREFLIGHT_SETTLE_MS);

    const surferInjected = (await page.evaluate(PREFLIGHT_SURFER_MARKER_SCRIPT)) as boolean;
    if (!surferInjected) {
      throw new ResearchError(
        'SURFER_NOT_DETECTED',
        `Keyword Surfer extension is not injecting into Google pages (expected "${SURFER_MARKERS.cssMarker}" marker in <head>).`,
      );
    }
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError('GOOGLE_UNAVAILABLE', 'Google did not load during preflight.', {
      cause: error,
    });
  } finally {
    await page.close().catch(() => undefined);
  }
}