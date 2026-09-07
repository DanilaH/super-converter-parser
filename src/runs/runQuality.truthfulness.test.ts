import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config/config.js';
import type { StoredKeyword, StoredRelatedKeyword, StoredRun } from '../db/store.js';
import { ResearchError } from '../shared/errors.js';
import { buildRunQuality } from './runQuality.js';

const CONFIG = loadConfig({});

function run(configSnapshot: StoredRun['configSnapshot'] = CONFIG): StoredRun {
  return {
    runId: 'run-quality-truthfulness',
    state: 'completed_with_errors',
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T01:00:00.000Z',
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    configSnapshot,
    parserVersions: { surfer: '1.0.0', google: '1.4.0' },
    lookups: 0,
    pauseReason: null,
    forceRefresh: false,
    refreshKeywords: [],
  };
}

function keyword(
  idx: number,
  name: string,
  sources: StoredKeyword['sources'] = [{ type: 'seed', rowNumbers: [idx + 1] }],
): StoredKeyword {
  return {
    idx,
    id: `kw-${idx}`,
    keyword: name,
    normalizedKeyword: name,
    sources,
    status: 'completed',
    surfer: {
      volume: 100,
      cpc: 1,
      market: 'US',
      fetchedAt: '2026-09-07T00:10:00.000Z',
    },
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: `https://google.com/search?q=${idx}`,
      detectedLocation: 'New York, NY',
      geoWarning: false,
      serpStatus: 'empty',
      serpError: null,
    },
    error: null,
    collectedAt: '2026-09-07T00:10:00.000Z',
    cacheStatus: 'miss',
  };
}

function related(
  parentIdx: number,
  parentKeyword: string,
  relatedKeyword: string,
  volume: number,
  selectedForExpansion: boolean,
): StoredRelatedKeyword {
  return {
    runId: 'run-quality-truthfulness',
    parentIdx,
    parentKeyword,
    relatedKeyword,
    overlap: 80,
    volume,
    selectedForExpansion,
    status: 'ok',
    error: null,
  };
}

function expansionConfig(admissionVersion: 'v1' | 'v1.1'): StoredRun['configSnapshot'] {
  return {
    ...CONFIG,
    expansion: {
      ...CONFIG.expansion,
      enabled: true,
      admissionVersion,
    },
  } as unknown as StoredRun['configSnapshot'];
}

function expansionFixture() {
  const keywords = [
    keyword(0, 'root zero'),
    keyword(1, 'root one'),
    keyword(2, 'shared tool', [{ type: 'surfer_related', parentKeyword: 'root zero', overlap: 80 }]),
    keyword(3, 'alpha tool', [{ type: 'surfer_related', parentKeyword: 'root zero', overlap: 80 }]),
    keyword(4, 'beta tool', [{ type: 'surfer_related', parentKeyword: 'root one', overlap: 80 }]),
  ];
  const relatedKeywords = [
    related(0, 'root zero', 'shared tool', 100, true),
    related(0, 'root zero', 'alpha tool', 90, true),
    related(0, 'root zero', 'budget reject', 10, false),
    related(1, 'root one', 'shared tool', 100, true),
    related(1, 'root one', 'beta tool', 80, true),
  ];
  return { keywords, relatedKeywords };
}

test('incomplete high coverage never rounds up to a false 100 percent', () => {
  const keywords = Array.from({ length: 200 }, (_, idx) => keyword(idx, `keyword ${idx}`));
  keywords[199] = {
    ...keywords[199]!,
    status: 'failed',
    surfer: null,
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: 'https://google.com/search?q=199',
      detectedLocation: null,
      geoWarning: false,
      serpStatus: 'fetch_error',
      serpError: { code: 'CAPTCHA_REQUIRED', message: 'blocked' },
    },
    error: { code: 'CAPTCHA_REQUIRED', message: 'blocked' },
  };

  const quality = buildRunQuality({
    run: run(),
    state: 'completed_with_errors',
    keywords,
    serpRows: [],
    relatedKeywords: [],
    domains: [],
  });

  assert.equal(quality.sources.googleSerp.trustworthy, 199);
  assert.equal(quality.sources.googleSerp.coveragePercent, 99.5);
  assert.equal(quality.sources.surfer.observed, 199);
  assert.equal(quality.sources.surfer.coveragePercent, 99.5);
});

test('persisted V1 diagnostics keep V1 accounting after v1.1 becomes current', () => {
  const { keywords, relatedKeywords } = expansionFixture();
  const quality = buildRunQuality({
    run: run(expansionConfig('v1')),
    state: 'completed',
    keywords,
    serpRows: [],
    relatedKeywords,
    domains: [],
  });
  const expansion = quality.bounds.relatedExpansion;

  assert.equal(quality.version, '1.2.0');
  assert.equal(expansion.selectedRows, 4, 'legacy alias stays occurrence-scoped');
  assert.equal(expansion.selectedOccurrenceRows, 4);
  assert.equal(expansion.admissionVersion, 'v1');
  assert.equal(expansion.rawUniqueCandidateCount, 4);
  assert.equal(expansion.eligibleUniqueCandidateCount, 4);
  assert.equal(expansion.policySelectedUniqueKeywordCount, 3);
  assert.equal(expansion.selectedUniqueKeywordCount, 3);
  assert.equal(expansion.policyRejectedUniqueCandidateCount, 1);
  assert.deepEqual(expansion.policyRejectionReasonCounts, { global_budget: 1 });
  assert.equal(expansion.admissionAccounting, 'v1_replayed_from_durable_evidence');
});

test('persisted V1.1 diagnostics identify V1.1 policy replay separately', () => {
  const { keywords, relatedKeywords } = expansionFixture();
  const quality = buildRunQuality({
    run: run(expansionConfig('v1.1')),
    state: 'completed',
    keywords,
    serpRows: [],
    relatedKeywords,
    domains: [],
  });
  const expansion = quality.bounds.relatedExpansion;

  assert.equal(quality.version, '1.2.0');
  assert.equal(expansion.admissionVersion, 'v1.1');
  assert.equal(expansion.policySelectedUniqueKeywordCount, 3);
  assert.equal(expansion.selectedUniqueKeywordCount, 3);
  assert.equal(expansion.admissionAccounting, 'v1_1_replayed_from_durable_evidence');
});

test('run-quality replay fails closed on an unknown persisted admission version', () => {
  const unknownConfig = {
    ...CONFIG,
    expansion: {
      ...CONFIG.expansion,
      enabled: true,
      admissionVersion: 'v999',
    },
  } as unknown as StoredRun['configSnapshot'];

  assert.throws(
    () => buildRunQuality({
      run: run(unknownConfig),
      state: 'completed',
      keywords: [keyword(0, 'root zero')],
      serpRows: [],
      relatedKeywords: [],
      domains: [],
    }),
    (error: unknown) => error instanceof ResearchError && error.code === 'RESUME_CONFIG_MISMATCH',
  );
});
