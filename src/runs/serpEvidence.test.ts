import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSerpEvidence } from './serpEvidence.js';
import type { KeywordRecord } from './run.js';

function google(
  serpStatus: NonNullable<KeywordRecord['google']>['serpStatus'],
  serpError: NonNullable<KeywordRecord['google']>['serpError'] = null,
): KeywordRecord['google'] {
  return {
    hl: 'en',
    gl: 'us',
    pageUrl: 'https://google.com/search?q=x',
    detectedLocation: null,
    geoWarning: false,
    serpStatus,
    serpError,
  };
}

test('explicit successful SERP with rows publishes the stored organic count', () => {
  assert.deepEqual(
    resolveSerpEvidence({ status: 'partial', error: { code: 'SURFER_PARSE_ERROR', message: 'bad surfer' }, google: google('ok') }, 7),
    { status: 'ok', organicResultCount: 7, errorCode: null, errorMessage: null, trustworthy: true },
  );
});

test('explicit genuine empty SERP publishes numeric zero even when the keyword failed elsewhere', () => {
  assert.deepEqual(
    resolveSerpEvidence({ status: 'failed', error: { code: 'SURFER_PARSE_ERROR', message: 'bad surfer' }, google: google('empty') }, 0),
    { status: 'empty', organicResultCount: 0, errorCode: null, errorMessage: null, trustworthy: true },
  );
});

test('Google parse and fetch failures never become numeric zero', () => {
  assert.deepEqual(
    resolveSerpEvidence(
      {
        status: 'partial',
        error: { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'bad serp' },
        google: google('parse_error', { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'bad serp' }),
      },
      0,
    ),
    {
      status: 'parse_error',
      organicResultCount: null,
      errorCode: 'GOOGLE_SERP_PARSE_ERROR',
      errorMessage: 'bad serp',
      trustworthy: false,
    },
  );
  assert.deepEqual(
    resolveSerpEvidence(
      {
        status: 'failed',
        error: { code: 'GOOGLE_UNAVAILABLE', message: 'navigation failed' },
        google: google('fetch_error', { code: 'GOOGLE_UNAVAILABLE', message: 'navigation failed' }),
      },
      0,
    ),
    {
      status: 'fetch_error',
      organicResultCount: null,
      errorCode: 'GOOGLE_UNAVAILABLE',
      errorMessage: 'navigation failed',
      trustworthy: false,
    },
  );
});

test('not-fetched evidence stays missing', () => {
  assert.equal(
    resolveSerpEvidence({ status: 'pending', error: null, google: null }, 0).organicResultCount,
    null,
  );
});

test('legacy completed clean zero remains a provable genuine empty SERP when Google metadata exists', () => {
  const legacyGoogle: KeywordRecord['google'] = {
    hl: 'en',
    gl: 'us',
    pageUrl: 'https://google.com/search?q=x',
    detectedLocation: null,
    geoWarning: false,
  };
  assert.deepEqual(
    resolveSerpEvidence({ status: 'completed', error: null, google: legacyGoogle }, 0),
    { status: 'empty', organicResultCount: 0, errorCode: null, errorMessage: null, trustworthy: true },
  );
});

test('legacy completed row without Google metadata is unknown rather than fabricated zero', () => {
  assert.deepEqual(
    resolveSerpEvidence({ status: 'completed', error: null, google: null }, 0),
    { status: 'unknown', organicResultCount: null, errorCode: null, errorMessage: null, trustworthy: false },
  );
});

test('legacy terminal row with only a Surfer error and no SERP rows is ambiguous, not zero', () => {
  const legacyGoogle: KeywordRecord['google'] = {
    hl: 'en',
    gl: 'us',
    pageUrl: 'https://google.com/search?q=x',
    detectedLocation: null,
    geoWarning: false,
  };
  assert.deepEqual(
    resolveSerpEvidence(
      { status: 'failed', error: { code: 'SURFER_PARSE_ERROR', message: 'widget failed' }, google: legacyGoogle },
      0,
    ),
    { status: 'unknown', organicResultCount: null, errorCode: null, errorMessage: null, trustworthy: false },
  );
});

test('inconsistent explicit success/empty states are projected as unknown rather than invented evidence', () => {
  assert.equal(resolveSerpEvidence({ status: 'completed', error: null, google: google('ok') }, 0).status, 'unknown');
  assert.equal(resolveSerpEvidence({ status: 'completed', error: null, google: google('empty') }, 2).status, 'unknown');
});
