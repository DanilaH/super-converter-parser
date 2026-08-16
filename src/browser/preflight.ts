import type { BrowserContext, Page } from 'playwright-core';
import type { ResearchConfig } from '../config/config.js';
import { ResearchError } from '../shared/errors.js';
import { buildSearchUrl } from '../google/serp.js';
import { SURFER_MARKERS } from '../surfer/selectors.js';
import { pauseForManualCaptcha, waitForManualCaptcha } from './captcha.js';

const PREFLIGHT_QUERY = 'preflight probe';
const PREFLIGHT_POLL_INTERVAL_MS = 2_000;
const PREFLIGHT_MARKER_TIMEOUT_MS = 60_000;

// Keyword Surfer injects its marker CSS as a direct child of <html>, so the
// check scans the whole document. Selector comes from SURFER_MARKERS.
const PREFLIGHT_SURFER_MARKER_SCRIPT = String.raw`(() => {
  const root = document.documentElement || document;
  return root.innerHTML.indexOf(${JSON.stringify(SURFER_MARKERS.cssMarker)}) !== -1;
})()`;

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

    await page.waitForTimeout(PREFLIGHT_POLL_INTERVAL_MS);

    const markerDeadline = Date.now() + PREFLIGHT_MARKER_TIMEOUT_MS;
    let surferInjected = false;
    while (Date.now() <= markerDeadline) {
      surferInjected = (await page.evaluate(PREFLIGHT_SURFER_MARKER_SCRIPT)) as boolean;
      if (surferInjected) break;
      await page.waitForTimeout(PREFLIGHT_POLL_INTERVAL_MS);
    }

    if (!surferInjected) {
      throw new ResearchError(
        'SURFER_NOT_DETECTED',
        `Keyword Surfer extension is not injecting into Google pages (expected "${SURFER_MARKERS.cssMarker}" marker in the page document).`,
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