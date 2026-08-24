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
  // rdap + firstSeen defaults.
  assert.equal(config.rdap.bootstrapBase, 'https://data.iana.org/rdap/');
  assert.equal(config.rdap.perHostMinDelayMs, 500);
  assert.equal(config.firstSeen.provider, '');
  assert.equal(config.firstSeen.endpoint, '');
  assert.equal(config.cache.ttl.domainAge.rdapOkMs, 180 * 24 * 60 * 60 * 1000);
  assert.equal(config.cache.ttl.domainAge.firstSeenUnavailableMs, 24 * 60 * 60 * 1000);
});

test('loadConfig applies RDAP and first-seen overrides', () => {
  const config = loadConfig({
    RDAP_BOOTSTRAP_BASE: 'https://rdap.example.test/',
    RDAP_PER_HOST_MIN_DELAY_MS: '250',
    FIRST_SEEN_PROVIDER: 'wayback',
    FIRST_SEEN_ENDPOINT: 'https://archive.example.test/cdx',
    CACHE_TTL_RDAP_ERROR_MS: '7200000',
  } as NodeJS.ProcessEnv);

  assert.equal(config.rdap.bootstrapBase, 'https://rdap.example.test/');
  assert.equal(config.rdap.perHostMinDelayMs, 250);
  assert.equal(config.firstSeen.provider, 'wayback');
  assert.equal(config.firstSeen.endpoint, 'https://archive.example.test/cdx');
  assert.equal(config.cache.ttl.domainAge.rdapErrorMs, 7200000);
});

test('loadConfig rejects unknown first-seen provider', () => {
  assert.throws(
    () => loadConfig({ FIRST_SEEN_PROVIDER: 'securitytrails' } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR',
  );
});

test('loadConfig rejects bogus first-seen endpoint', () => {
  assert.throws(
    () => loadConfig({ FIRST_SEEN_PROVIDER: 'wayback', FIRST_SEEN_ENDPOINT: 'not-a-url' } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR',
  );
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