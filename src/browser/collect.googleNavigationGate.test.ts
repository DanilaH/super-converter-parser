import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';
import { loadConfig } from '../config/config.js';
import {
  BODY_TEXT_SCRIPT,
  GOOGLE_NO_RESULTS_SCRIPT,
  LOCATION_EXTRACT_SCRIPT,
  ORGANIC_EXTRACT_SCRIPT,
} from '../google/serp.js';
import { ResearchError } from '../shared/errors.js';
import type { KeywordRecord } from '../runs/run.js';
import { collectKeyword, collectRelatedKeyword } from './collect.js';

const config = loadConfig({ SURFER_WAIT_MS: '25' } as NodeJS.ProcessEnv);

function expandedKeyword(): KeywordRecord {
  return {
    id: 'k1',
    keyword: 'favicon maker',
    normalizedKeyword: 'favicon maker',
    sources: [{ type: 'surfer_related', parentKeyword: 'favicon generator' }],
    surfer: null,
    google: null,
    status: 'pending',
    error: null,
  };
}

test('primary and related-only collectors share the BrowserContext navigation gate', async () => {
  let newPageCalls = 0;
  const page = fakePage();
  const context = {
    newPage: async () => {
      newPageCalls += 1;
      return page;
    },
  } as unknown as BrowserContext;
  const debugRoot = await mkdtemp(join(tmpdir(), 'google-gate-'));

  const first = await collectKeyword(context, config, expandedKeyword(), debugRoot);
  assert.equal(first.record.status, 'completed');
  assert.equal(newPageCalls, 1);

  await assert.rejects(
    collectRelatedKeyword(
      context,
      config,
      expandedKeyword(),
      debugRoot,
      { isCancelled: () => true },
    ),
    (error: unknown) => error instanceof ResearchError && error.code === 'RUN_PAUSED',
  );
  assert.equal(newPageCalls, 1, 'cancelled pacing must stop before opening a second page');
});

function fakePage(): Page {
  const captchaSelector = 'form[action*="sorry"], iframe[src*="recaptcha"], #captcha';
  return {
    isClosed: () => false,
    goto: async () => undefined,
    url: () => 'https://google.com/search?q=favicon+maker',
    locator: (selector: string) => {
      if (selector === captchaSelector) {
        return { count: async () => 0, innerText: async () => '' };
      }
      if (selector === config.browser.surferWidgetSelector) {
        return { first: () => ({ innerText: async () => '$100 $2' }) };
      }
      if (selector === 'body') {
        return { count: async () => 1, innerText: async () => '' };
      }
      return { count: async () => 0, innerText: async () => '' };
    },
    evaluate: async (script: unknown) => {
      if (script === ORGANIC_EXTRACT_SCRIPT) {
        return [{ href: 'https://example.com/page', title: 'Example' }];
      }
      if (script === GOOGLE_NO_RESULTS_SCRIPT) return false;
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
}
