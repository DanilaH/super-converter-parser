import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import type { SerpResult } from '../google/serp.js';
import { RunStore } from '../db/store.js';
import { loadKeywordRetryAttempts } from '../db/retryAttempts.js';
import {
  applyFailedKeywordRetryPreparation,
  prepareFailedKeywordRetry,
} from './retryFailed.js';

const CONFIG = loadConfig({});
const RUN_ID = 'run-retry-partial';

function row(keyword: string, keywordIdx: number): SerpResult {
  return {
    keyword,
    keywordIdx,
    position: 1,
    title: 'Example',
    url: 'https://example.com/tool',
    hostname: 'example.com',
    registrableDomain: 'example.com',
    dr: 10,
    drStatus: 'ok',
    drError: null,
    resultType: 'organic',
  };
}

function setup(): RunStore {
  const store = RunStore.openInMemory();
  store.createRun({
    runId: RUN_ID,
    configSnapshot: CONFIG,
    parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: buildSeedKeywords([
      { keyword: 'surfer partial', rowNumber: 1 },
      { keyword: 'google partial', rowNumber: 2 },
      { keyword: 'inconsistent partial', rowNumber: 3 },
    ]),
  });

  const surferPartial = store.loadKeyword(RUN_ID, 0)!;
  store.commitKeyword(RUN_ID, {
    ...surferPartial,
    status: 'partial',
    surfer: null,
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: 'https://www.google.com/search?q=surfer+partial',
      detectedLocation: null,
      geoWarning: false,
      serpStatus: 'ok',
      serpError: null,
    },
    error: { code: 'SURFER_PARSE_ERROR', message: 'widget missing' },
    collectedAt: '2026-08-29T18:00:00.000Z',
  }, [row('surfer partial', 0)], 'miss');

  const googlePartial = store.loadKeyword(RUN_ID, 1)!;
  store.commitKeyword(RUN_ID, {
    ...googlePartial,
    status: 'partial',
    surfer: {
      volume: 100,
      cpc: 1.2,
      market: 'US',
      fetchedAt: '2026-08-29T18:01:00.000Z',
    },
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: 'https://www.google.com/search?q=google+partial',
      detectedLocation: null,
      geoWarning: false,
      serpStatus: 'parse_error',
      serpError: { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'selector failed' },
    },
    error: { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'selector failed' },
    collectedAt: '2026-08-29T18:01:00.000Z',
  }, [], 'miss');

  const inconsistent = store.loadKeyword(RUN_ID, 2)!;
  store.commitKeyword(RUN_ID, {
    ...inconsistent,
    status: 'partial',
    surfer: {
      volume: 50,
      cpc: null,
      market: 'US',
      fetchedAt: '2026-08-29T18:02:00.000Z',
    },
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: 'https://www.google.com/search?q=inconsistent+partial',
      detectedLocation: null,
      geoWarning: false,
      serpStatus: 'ok',
      serpError: null,
    },
    error: { code: 'SURFER_PARSE_ERROR', message: 'stale aggregate error' },
    collectedAt: '2026-08-29T18:02:00.000Z',
  }, [row('inconsistent partial', 2)], 'miss');

  store.setRunState(RUN_ID, 'completed_with_errors');
  return store;
}

test('--retry-failed repairs primary partial checkpoints without broad partial retry', () => {
  const store = setup();

  const preparation = prepareFailedKeywordRetry(
    store,
    RUN_ID,
    '2026-08-29T19:00:00.000Z',
  );
  assert.deepEqual(preparation.plannedKeywordIdxs, [0, 1]);

  assert.deepEqual(applyFailedKeywordRetryPreparation(store, preparation), [0, 1]);
  assert.equal(store.loadKeyword(RUN_ID, 0)?.status, 'pending');
  assert.equal(store.loadKeyword(RUN_ID, 1)?.status, 'pending');
  assert.equal(store.loadKeyword(RUN_ID, 2)?.status, 'partial');

  const attempts = loadKeywordRetryAttempts(store, RUN_ID);
  assert.deepEqual(attempts.map((attempt) => attempt.keywordIdx), [0, 1]);
  assert.deepEqual(attempts.map((attempt) => attempt.previousRecord.status), ['partial', 'partial']);
  assert.deepEqual(attempts[0]?.previousSerpRows.map((serp) => serp.registrableDomain), ['example.com']);
  assert.deepEqual(attempts[1]?.previousSerpRows, []);

  const currentSerpIndexes = store.loadSerpRows(RUN_ID).map((serp) => serp.keywordIdx);
  assert.deepEqual(currentSerpIndexes, [2]);
  store.close();
});
