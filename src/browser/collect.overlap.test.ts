import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { collectKeyword, collectRelatedKeyword } from './collect.js';
import { loadConfig } from '../config/config.js';
import {
  BODY_TEXT_SCRIPT,
  GOOGLE_NO_RESULTS_SCRIPT,
  LOCATION_EXTRACT_SCRIPT,
  ORGANIC_EXTRACT_SCRIPT,
} from '../google/serp.js';
import type { KeywordRecord } from '../runs/run.js';

const config = loadConfig({
  SURFER_WAIT_MS: '1000',
  SURFER_RELATED_MISSING_WIDGET_TIMEOUT_MS: '1000',
} as NodeJS.ProcessEnv);

function rootKeyword(): KeywordRecord {
  return {
    id: 'root-1',
    keyword: 'favicon generator',
    normalizedKeyword: 'favicon generator',
    sources: [{ type: 'seed', rowNumbers: [2] }],
    surfer: null,
    google: null,
    status: 'pending',
    error: null,
  };
}

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

test('root collection premounts Related while main Surfer is pending but delays terminal Related read until after main', async () => {
  const mainGate = deferred();
  let mainReadStarted = false;
  let relatedMountStarted = false;
  let relatedReadStarted = false;
  let serpReadStarted = false;
  const waits: number[] = [];

  const context = fakeContext({
    mainInnerText: async () => {
      mainReadStarted = true;
      await mainGate.promise;
      return '$100 $2';
    },
    onRelatedMount: () => {
      relatedMountStarted = true;
    },
    onRelatedRead: () => {
      relatedReadStarted = true;
    },
    onSerpRead: () => {
      serpReadStarted = true;
    },
    onWait: (ms) => waits.push(ms),
  });

  const debugRoot = await mkdtemp(join(tmpdir(), 'collect-overlap-'));
  const collection = collectKeyword(context, config, rootKeyword(), debugRoot);

  const premounted = await waitFor(() => mainReadStarted && relatedMountStarted, 250);
  assert.equal(premounted, true, 'Related lazy mount should be triggered while main Surfer is still pending');
  assert.equal(relatedReadStarted, false, 'terminal Related reader must not start before main Surfer completes');
  assert.equal(serpReadStarted, false, 'SERP evidence must not be captured before Surfer observations finish');

  mainGate.resolve();
  const result = await collection;

  assert.equal(result.record.status, 'completed');
  assert.equal(result.record.surfer?.volume, 100);
  assert.equal(result.related.status, 'ok');
  assert.equal(result.related.rows[0]?.normalizedKeyword, 'favicon maker');
  assert.equal(relatedReadStarted, true);
  assert.equal(serpReadStarted, true);
  assert.ok(waits.includes(1000), 'historical Related warm-up must remain before terminal read');
});

test('related-only collection keeps the historical fixed one-second warm-up', async () => {
  const waits: number[] = [];
  const context = fakeContext({
    mainInnerText: async () => '$100 $2',
    onWait: (ms) => waits.push(ms),
  });
  const debugRoot = await mkdtemp(join(tmpdir(), 'collect-related-fixed-wait-'));

  const result = await collectRelatedKeyword(context, config, rootKeyword(), debugRoot);

  assert.equal(result.related.status, 'ok');
  assert.deepEqual(waits, [1000]);
});

function fakeContext(options: {
  mainInnerText: () => Promise<string>;
  onRelatedMount?: () => void;
  onRelatedRead?: () => void;
  onSerpRead?: () => void;
  onWait?: (ms: number) => void;
}): BrowserContext {
  const captchaSelector = 'form[action*="sorry"], iframe[src*="recaptcha"], #captcha';
  const page = {
    isClosed: () => false,
    goto: async () => undefined,
    url: () => 'https://google.com/search?q=favicon+generator',
    locator: (selector: string) => {
      if (selector === captchaSelector) {
        return { count: async () => 0, innerText: async () => '' };
      }
      if (selector === config.browser.surferWidgetSelector) {
        return { first: () => ({ innerText: options.mainInnerText }) };
      }
      if (selector === 'body') {
        return { count: async () => 1, innerText: async () => '' };
      }
      return { count: async () => 0, innerText: async () => '' };
    },
    evaluate: async (script: unknown, arg?: unknown) => {
      if (script === ORGANIC_EXTRACT_SCRIPT) {
        options.onSerpRead?.();
        return [{ href: 'https://example.com/', title: 'Example' }];
      }
      if (script === GOOGLE_NO_RESULTS_SCRIPT) return false;
      if (script === LOCATION_EXTRACT_SCRIPT) return null;
      if (script === BODY_TEXT_SCRIPT) return '';
      if (typeof script === 'function' && arg === config.browser.surferRelatedWidgetSelector) {
        options.onRelatedRead?.();
        return {
          state: 'rows',
          rows: [{ keyword: 'favicon maker', overlapText: '50%', volumeText: '1K' }],
        };
      }
      if (typeof script === 'function' && arg === undefined) {
        options.onRelatedMount?.();
      }
      return undefined;
    },
    waitForTimeout: async (ms: number) => {
      options.onWait?.(ms);
    },
    waitForLoadState: async () => undefined,
    screenshot: async () => undefined,
    content: async () => '<html></html>',
    close: async () => undefined,
  } as unknown as Page;
  return { newPage: async () => page } as unknown as BrowserContext;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return predicate();
}
