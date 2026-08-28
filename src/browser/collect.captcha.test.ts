import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { collectKeyword } from './collect.js';
import { loadConfig } from '../config/config.js';
import {
  ORGANIC_EXTRACT_SCRIPT,
  GOOGLE_NO_RESULTS_SCRIPT,
  LOCATION_EXTRACT_SCRIPT,
} from '../google/serp.js';
import type { KeywordRecord } from '../runs/run.js';

// Exercises the REAL captcha surface inside collectKeyword: it must invoke
// waitForManualCaptcha, and when a captcha is present, route into
// pauseForManualCaptcha (the same code the CLI uses) and only then continue
// collection. The fake page clears the CAPTCHA after its first detection.
test('collectKeyword detects a captcha, waits for the page to clear, then completes', async () => {

  const config = loadConfig({ EXPANSION_ENABLED: 'false' } as NodeJS.ProcessEnv);
  const surferWidgetSelector = config.browser.surferWidgetSelector;
  const captchaSelector = 'form[action*="sorry"], iframe[src*="recaptcha"], #captcha';
  let captchaChecks = 0;

  const page = {
    isClosed: () => false,
    goto: async () => undefined,
    url: () => 'https://google.com/search?q=compare+lists',
    locator: (sel: string) => {
      if (sel === captchaSelector) {
        return { count: async () => (captchaChecks++ === 0 ? 1 : 0), innerText: async () => '' };
      }
      if (sel === surferWidgetSelector) return { first: () => ({ innerText: async () => '$49,500' }) };
      if (sel === 'body') return { count: async () => 0, innerText: async () => 'normal' };
      return { count: async () => 0, innerText: async () => '' };
    },
    evaluate: async (script: unknown) => {
      if (script === ORGANIC_EXTRACT_SCRIPT) return [{ href: 'https://example.com/1', title: 't' }];
      if (script === GOOGLE_NO_RESULTS_SCRIPT) return false;
      if (script === LOCATION_EXTRACT_SCRIPT) return null;
      return undefined;
    },
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    screenshot: async () => undefined,
    content: async () => '<html></html>',
    close: async () => undefined,
  } as unknown as Page;

  const context = { newPage: async () => page } as unknown as BrowserContext;

  const keyword: KeywordRecord = {
    id: 'k1',
    keyword: 'compare lists',
    normalizedKeyword: 'compare lists',
    sources: [{ type: 'seed', rowNumbers: [1] }],
    surfer: null,
    google: null,
    status: 'pending',
    error: null,
  };

  const debugRoot = await mkdtemp(join(tmpdir(), 'collect-captcha-debug-'));

  const result = await collectKeyword(context, config, keyword, debugRoot);

  assert.equal(result.record.status, 'completed', 'collection continues after the manual pause');
  assert.equal(result.record.surfer?.volume, 49500, 'Surfer volume parsed after resume');
  assert.equal(result.record.google?.geoWarning, false);
});
