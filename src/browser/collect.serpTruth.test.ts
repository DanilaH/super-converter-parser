import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { collectKeyword } from './collect.js';
import { loadConfig } from '../config/config.js';
import {
  BODY_TEXT_SCRIPT,
  GOOGLE_NO_RESULTS_SCRIPT,
  LOCATION_EXTRACT_SCRIPT,
  ORGANIC_EXTRACT_SCRIPT,
} from '../google/serp.js';
import type { KeywordRecord } from '../runs/run.js';

const config = loadConfig({
  EXPANSION_ENABLED: 'false',
  // readSurferResult compares Date.now() against the deadline. A literal 0 ms
  // makes the test depend on two clock reads landing in the same millisecond.
  SURFER_WAIT_MS: '25',
} as NodeJS.ProcessEnv);

function keyword(): KeywordRecord {
  return {
    id: 'k1',
    keyword: 'compare lists',
    normalizedKeyword: 'compare lists',
    // Mark this as an already-expanded child so the unrelated Surfer-related
    // widget is not collected in these source-truth tests.
    sources: [{ type: 'surfer_related', parentKeyword: 'parent' }],
    surfer: null,
    google: null,
    status: 'pending',
    error: null,
  };
}

type PageScenario = {
  surferText: string;
  organic: Array<{ href: string; title: string }>;
  noResults: boolean;
  navigationError?: Error;
};

function fakeContext(scenario: PageScenario): BrowserContext {
  const captchaSelector = 'form[action*="sorry"], iframe[src*="recaptcha"], #captcha';
  const page = {
    isClosed: () => false,
    goto: async () => {
      if (scenario.navigationError) throw scenario.navigationError;
    },
    url: () => 'https://google.com/search?q=compare+lists',
    locator: (selector: string) => {
      if (selector === captchaSelector) {
        return { count: async () => 0, innerText: async () => '' };
      }
      if (selector === config.browser.surferWidgetSelector) {
        return { first: () => ({ innerText: async () => scenario.surferText }) };
      }
      if (selector === 'body') {
        return { count: async () => 1, innerText: async () => '' };
      }
      return { count: async () => 0, innerText: async () => '' };
    },
    evaluate: async (script: unknown) => {
      if (script === ORGANIC_EXTRACT_SCRIPT) return scenario.organic;
      if (script === GOOGLE_NO_RESULTS_SCRIPT) return scenario.noResults;
      if (script === LOCATION_EXTRACT_SCRIPT) return null;
      if (script === BODY_TEXT_SCRIPT) return '';
      return undefined;
    },
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    screenshot: async () => undefined,
    content: async () => '<html></html>',
    close: async () => undefined,
  } as unknown as Page;
  return { newPage: async () => page } as unknown as BrowserContext;
}

async function collect(scenario: PageScenario) {
  const debugRoot = await mkdtemp(join(tmpdir(), 'serp-truth-debug-'));
  return collectKeyword(fakeContext(scenario), config, keyword(), debugRoot);
}

test('Surfer success plus Google rows persists a trustworthy non-zero SERP observation', async () => {
  const result = await collect({
    surferText: '$100 $2',
    organic: [{ href: 'https://example.com/page', title: 'Example' }],
    noResults: false,
  });

  assert.equal(result.record.status, 'completed');
  assert.equal(result.record.surfer?.volume, 100);
  assert.equal(result.record.google?.serpStatus, 'ok');
  assert.equal(result.record.google?.serpError, null);
  assert.equal(result.serpRows.length, 1);
});

test('Surfer success plus a genuine Google zero persists numeric-zero evidence', async () => {
  const result = await collect({ surferText: '$100 $2', organic: [], noResults: true });

  assert.equal(result.record.status, 'completed');
  assert.equal(result.record.surfer?.volume, 100);
  assert.equal(result.record.google?.serpStatus, 'empty');
  assert.equal(result.record.google?.serpError, null);
  assert.equal(result.serpRows.length, 0);
});

test('Surfer failure does not erase a genuine Google zero-result observation', async () => {
  const result = await collect({ surferText: 'not a number', organic: [], noResults: true });

  assert.equal(result.record.status, 'failed');
  assert.equal(result.record.error?.code, 'SURFER_PARSE_ERROR');
  assert.equal(result.record.google?.serpStatus, 'empty');
  assert.equal(result.record.google?.serpError, null);
  assert.equal(result.serpRows.length, 0);
});

test('Surfer failure does not erase successfully parsed Google rows', async () => {
  const result = await collect({
    surferText: 'not a number',
    organic: [{ href: 'https://example.com/page', title: 'Example' }],
    noResults: false,
  });

  assert.equal(result.record.status, 'partial');
  assert.equal(result.record.error?.code, 'SURFER_PARSE_ERROR');
  assert.equal(result.record.google?.serpStatus, 'ok');
  assert.equal(result.serpRows.length, 1);
});

test('Google parser failure is persisted separately and makes a Surfer-success keyword partial', async () => {
  const result = await collect({ surferText: '$100 $2', organic: [], noResults: false });

  assert.equal(result.record.status, 'partial');
  assert.equal(result.record.surfer?.volume, 100);
  assert.equal(result.record.google?.serpStatus, 'parse_error');
  assert.equal(result.record.google?.serpError?.code, 'GOOGLE_SERP_PARSE_ERROR');
  assert.equal(result.record.error?.code, 'GOOGLE_SERP_PARSE_ERROR');
});

test('navigation failure is persisted as a Google fetch error', async () => {
  const result = await collect({
    surferText: '$100',
    organic: [],
    noResults: false,
    navigationError: new Error('network down'),
  });

  assert.equal(result.record.status, 'failed');
  assert.equal(result.record.google?.serpStatus, 'fetch_error');
  assert.equal(result.record.google?.serpError?.code, 'GOOGLE_UNAVAILABLE');
  assert.equal(result.record.error?.code, 'GOOGLE_UNAVAILABLE');
});
