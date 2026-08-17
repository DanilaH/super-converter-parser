import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';
import { ResearchError } from '../shared/errors.js';

test('loadConfig returns defaults', () => {
  const config = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.research.market, 'US');
  assert.equal(config.research.googleHl, 'en');
  assert.equal(config.research.googleGl, 'us');
  assert.equal(config.research.topN, 10);
  assert.equal(config.browser.cdpUrl, 'http://127.0.0.1:9222');
  assert.equal(config.browser.surferWaitTimeoutMs, 60000);
  assert.equal(config.browser.surferPreflightTimeoutMs, 60000);
  assert.equal(config.browser.surferWidgetSelector, '.surfer-main-keyword-widget');
});

test('loadConfig applies environment overrides', () => {
  const config = loadConfig({
    CDP_URL: 'http://127.0.0.1:9333',
    SURFER_WAIT_MS: '45000',
    SURFER_PREFLIGHT_TIMEOUT_MS: '45000',
    NAVIGATION_TIMEOUT_MS: '90000',
    RESEARCH_MARKET: 'DE',
    GOOGLE_HL: 'de',
    GOOGLE_GL: 'de',
    TOP_N: '15',
    SURFER_WIDGET_SELECTOR: '#broken-selector',
    CACHE_TTL_RELATED_ERROR_MS: '1800000',
  } as NodeJS.ProcessEnv);

  assert.equal(config.browser.cdpUrl, 'http://127.0.0.1:9333');
  assert.equal(config.browser.surferWaitTimeoutMs, 45000);
  assert.equal(config.browser.surferPreflightTimeoutMs, 45000);
  assert.equal(config.browser.navigationTimeoutMs, 90000);
  assert.equal(config.research.market, 'DE');
  assert.equal(config.research.googleHl, 'de');
  assert.equal(config.research.googleGl, 'de');
  assert.equal(config.research.topN, 15);
  assert.equal(config.browser.surferWidgetSelector, '#broken-selector');
  assert.equal(config.cache.ttl.relatedErrorMs, 1800000);
});

test('loadConfig rejects invalid TOP_N', () => {
  assert.throws(
    () => loadConfig({ TOP_N: '0' } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR',
  );
  assert.throws(
    () => loadConfig({ TOP_N: '31' } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR',
  );
});

test('loadConfig rejects non-numeric timeouts', () => {
  assert.throws(
    () => loadConfig({ SURFER_WAIT_MS: 'abc' } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR',
  );
});

test('loadConfig rejects breaker failures exceeding the window', () => {
  assert.throws(
    () =>
      loadConfig({
        BREAKER_SURFER_WINDOW: '15',
        BREAKER_SURFER_FAILURES: '16',
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR',
  );
  assert.doesNotThrow(() =>
    loadConfig({
      BREAKER_SURFER_WINDOW: '15',
      BREAKER_SURFER_FAILURES: '15',
    } as NodeJS.ProcessEnv),
  );
});