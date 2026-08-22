import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
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
// collection. We pre-create the marker file so the non-TTY pause returns fast.
test('collectKeyword detects a captcha, pauses on the marker, then completes', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'collect-captcha-')), 'done.txt');
  rmSync(marker, { force: true });
  await writeFile(marker, 'go');

  const originalTty = (process.stdin as { isTTY?: boolean }).isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  const originalMarker = process.env.CAPTCHA_DONE_MARKER;
  process.env.CAPTCHA_DONE_MARKER = marker;

  const config = loadConfig({ EXPANSION_ENABLED: 'false' } as NodeJS.ProcessEnv);
  const surferWidgetSelector = config.browser.surferWidgetSelector;
  const captchaSelector = 'form[action*="sorry"], iframe[src*="recaptcha"], #captcha';

  const page = {
    goto: async () => undefined,
    url: () => 'https://google.com/search?q=compare+lists',
    locator: (sel: string) => {
      if (sel === captchaSelector) return { count: async () => 1, innerText: async () => '' };
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

  let result;
  try {
    result = await collectKeyword(context, config, keyword, debugRoot);
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalTty, configurable: true });
    if (originalMarker === undefined) delete process.env.CAPTCHA_DONE_MARKER;
    else process.env.CAPTCHA_DONE_MARKER = originalMarker;
  }

  assert.equal(existsSync(marker), false, 'marker must be consumed by pauseForManualCaptcha');
  assert.equal(result.record.status, 'completed', 'collection continues after the manual pause');
  assert.equal(result.record.surfer?.volume, 49500, 'Surfer volume parsed after resume');
  assert.equal(result.record.google?.geoWarning, false);
});
