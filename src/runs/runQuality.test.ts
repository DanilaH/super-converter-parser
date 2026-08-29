import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config/config.js';
import type {
  StoredDomain,
  StoredKeyword,
  StoredRelatedKeyword,
  StoredRun,
} from '../db/store.js';
import type { SerpResult } from '../google/serp.js';
import type { AhrefsSummary } from './engine.js';
import { buildRunQuality } from './runQuality.js';

const CONFIG = loadConfig({});

function run(configSnapshot: StoredRun['configSnapshot'] = CONFIG): StoredRun {
  return {
    runId: 'run-quality',
    state: 'completed_with_errors',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T01:00:00.000Z',
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    configSnapshot,
    parserVersions: { surfer: '1.0.0', google: '1.4.0' },
    lookups: 4,
    pauseReason: null,
    forceRefresh: false,
    refreshKeywords: [],
  };
}

function keyword(
  idx: number,
  overrides: Partial<StoredKeyword> = {},
): StoredKeyword {
  return {
    idx,
    id: `kw-${idx}`,
    keyword: `keyword ${idx}`,
    normalizedKeyword: `keyword ${idx}`,
    sources: [{ type: 'seed', rowNumbers: [idx + 1] }],
    status: 'completed',
    surfer: {
      volume: 100,
      cpc: 1,
      market: 'US',
      fetchedAt: '2026-08-29T00:10:00.000Z',
    },
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: `https://google.com/search?q=${idx}`,
      detectedLocation: 'New York, NY',
      geoWarning: false,
      serpStatus: 'ok',
      serpError: null,
    },
    error: null,
    collectedAt: '2026-08-29T00:10:00.000Z',
    cacheStatus: 'miss',
    ...overrides,
  };
}

function serpRow(keywordIdx: number): SerpResult {
  return {
    keyword: `keyword ${keywordIdx}`,
    keywordIdx,
    position: 1,
    title: 'Result',
    url: `https://example-${keywordIdx}.com/tool`,
    hostname: `example-${keywordIdx}.com`,
    registrableDomain: `example-${keywordIdx}.com`,
    dr: null,
    drStatus: null,
    drError: null,
    resultType: 'organic',
  };
}

function related(
  parentIdx: number,
  status: StoredRelatedKeyword['status'],
  relatedKeyword = '',
): StoredRelatedKeyword {
  return {
    runId: 'run-quality',
    parentIdx,
    parentKeyword: `keyword ${parentIdx}`,
    relatedKeyword,
    overlap: status === 'ok' ? 80 : null,
    volume: status === 'ok' ? 20 : null,
    selectedForExpansion: false,
    status,
    error: status === 'error' ? 'SURFER_RELATED_PARSE_ERROR' : null,
  };
}

function domain(
  name: string,
  status: StoredDomain['status'],
  dr: number | null,
): StoredDomain {
  return {
    runId: 'run-quality',
    domain: name,
    dr,
    status,
    error: status === 'error' ? 'AHREFS_ERROR' : null,
    source: status === 'not_attempted' ? 'none' : 'fresh',
    fetchedAt: status === 'not_attempted' ? null : '2026-08-29T00:20:00.000Z',
    firstSeenKeyword: 'keyword 0',
    firstSeenKeywordIdx: 0,
    firstSeenPosition: 1,
  };
}

const AHREFS: AhrefsSummary = {
  mode: 'optional',
  state: 'degraded',
  discovered: 4,
  attempted: 3,
  notAttempted: 1,
  cache: 0,
  fresh: 3,
  ok: 1,
  notFound: 1,
  error: 1,
  numericCoverage: 1,
  requireAhrefs: false,
};

test('projects source-native mixed evidence with explicit denominators', () => {
  const keywords: StoredKeyword[] = [
    keyword(0),
    keyword(1, {
      status: 'failed',
      surfer: null,
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=1',
        detectedLocation: 'Chelyabinsk Oblast, Russia',
        geoWarning: true,
        serpStatus: 'empty',
        serpError: null,
      },
      error: { code: 'SURFER_PARSE_ERROR', message: 'Surfer failed' },
    }),
    keyword(2, {
      status: 'partial',
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=2',
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'parse_error',
        serpError: { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'selector failed' },
      },
      error: { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'selector failed' },
    }),
    keyword(3, {
      status: 'pending',
      surfer: null,
      google: null,
      error: null,
      collectedAt: null,
      cacheStatus: null,
    }),
  ];
  const relatedRows = [
    related(0, 'ok', 'idea one'),
    related(1, 'empty'),
    related(2, 'error'),
  ];
  const domains = [
    domain('one.example', 'ok', 12),
    domain('two.example', 'not_found', null),
    domain('three.example', 'error', null),
    domain('four.example', 'not_attempted', null),
  ];

  const quality = buildRunQuality({
    run: run(),
    state: 'completed_with_errors',
    keywords,
    serpRows: [serpRow(0)],
    relatedKeywords: relatedRows,
    domains,
    ahrefs: AHREFS,
  });

  assert.deepEqual(quality.sources.googleSerp, {
    denominator: 4,
    trustworthy: 2,
    coveragePercent: 50,
    statuses: {
      ok: 1,
      empty: 1,
      fetchError: 0,
      parseError: 1,
      notFetched: 1,
      unknown: 0,
    },
  });
  assert.deepEqual(quality.sources.surfer, {
    denominator: 4,
    observed: 2,
    coveragePercent: 50,
    volumeAvailable: 2,
    cpcAvailable: 2,
    statuses: { ok: 2, error: 1, notFetched: 1, unknown: 0 },
  });
  assert.deepEqual(quality.sources.related, {
    denominator: 4,
    successful: 2,
    coveragePercent: 50,
    realRows: 1,
    statuses: { ok: 1, empty: 1, error: 1, notAttempted: 1 },
  });
  assert.deepEqual(quality.sources.ahrefs, {
    denominator: 4,
    resolved: 3,
    resolvedCoveragePercent: 75,
    numeric: 1,
    numericCoveragePercent: 25,
    mode: 'optional',
    summaryState: 'degraded',
    statuses: { ok: 1, notFound: 1, error: 1, notAttempted: 1 },
  });
  assert.deepEqual(quality.geo, {
    grade: 'mismatch',
    targetMarket: 'US',
    googleHl: 'en',
    googleGl: 'us',
    detectedKeywords: 2,
    trustworthyDetectedKeywords: 2,
    mismatchKeywords: 1,
    detectedLocations: ['Chelyabinsk Oblast, Russia', 'New York, NY'],
  });
  assert.equal(quality.bounds.relatedExpansion.explicitOmissionCount, null);
  assert.equal(quality.bounds.relatedExpansion.omissionAccounting, 'not_persisted');
  assert.deepEqual(
    quality.warnings.map((item) => item.code),
    [
      'GOOGLE_SERP_INCOMPLETE',
      'SURFER_INCOMPLETE',
      'RELATED_ERRORS',
      'RELATED_NOT_ATTEMPTED',
      'AHREFS_ERRORS',
      'AHREFS_NOT_ATTEMPTED',
      'AHREFS_NUMERIC_INCOMPLETE',
      'GEO_MISMATCH',
    ],
  );
});

test('uses logical_only geo grade when SERP is trustworthy but physical location is absent', () => {
  const only = keyword(0, {
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: 'https://google.com/search?q=0',
      detectedLocation: null,
      geoWarning: false,
      serpStatus: 'empty',
      serpError: null,
    },
  });
  const quality = buildRunQuality({
    run: run(),
    state: 'completed',
    keywords: [only],
    serpRows: [],
    relatedKeywords: [related(0, 'empty')],
    domains: [],
  });

  assert.equal(quality.geo.grade, 'logical_only');
  assert.equal(quality.geo.trustworthyDetectedKeywords, 0);
  assert.equal(quality.sources.googleSerp.coveragePercent, 100);
  assert.equal(quality.sources.related.coveragePercent, 100);
  assert.equal(quality.sources.ahrefs.resolvedCoveragePercent, null);
  assert.equal(quality.sources.ahrefs.numericCoveragePercent, null);
  assert.deepEqual(quality.warnings.map((item) => item.code), ['GEO_LOGICAL_ONLY']);
});

test('partial physical geo coverage remains logical_only instead of verified', () => {
  const withLocation = keyword(0);
  const withoutLocation = keyword(1, {
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: 'https://google.com/search?q=1',
      detectedLocation: null,
      geoWarning: false,
      serpStatus: 'empty',
      serpError: null,
    },
  });

  const quality = buildRunQuality({
    run: run(),
    state: 'completed',
    keywords: [withLocation, withoutLocation],
    serpRows: [serpRow(0)],
    relatedKeywords: [related(0, 'empty'), related(1, 'empty')],
    domains: [],
  });

  assert.equal(quality.sources.googleSerp.trustworthy, 2);
  assert.equal(quality.geo.detectedKeywords, 1);
  assert.equal(quality.geo.trustworthyDetectedKeywords, 1);
  assert.equal(quality.geo.grade, 'logical_only');
  const geoWarning = quality.warnings.find((item) => item.code === 'GEO_LOGICAL_ONLY');
  assert.equal(geoWarning?.affected, 1);
  assert.equal(geoWarning?.denominator, 2);
});

test('complete physical geo coverage is verified', () => {
  const quality = buildRunQuality({
    run: run(),
    state: 'completed',
    keywords: [keyword(0), keyword(1)],
    serpRows: [serpRow(0), serpRow(1)],
    relatedKeywords: [related(0, 'empty'), related(1, 'empty')],
    domains: [],
  });

  assert.equal(quality.geo.grade, 'verified');
  assert.equal(quality.geo.trustworthyDetectedKeywords, 2);
  assert.equal(quality.warnings.some((item) => item.code.startsWith('GEO_')), false);
});

test('does not invent missing historical expansion bounds or zero coverage', () => {
  const legacyConfig = {
    ...CONFIG,
    expansion: undefined,
    ahrefs: undefined,
  } as unknown as StoredRun['configSnapshot'];

  const quality = buildRunQuality({
    run: run(legacyConfig),
    state: 'completed',
    keywords: [],
    serpRows: [],
    relatedKeywords: [],
    domains: [],
  });

  assert.equal(quality.sources.googleSerp.coveragePercent, null);
  assert.equal(quality.sources.surfer.coveragePercent, null);
  assert.equal(quality.sources.related.coveragePercent, null);
  assert.equal(quality.sources.ahrefs.resolvedCoveragePercent, null);
  assert.equal(quality.sources.ahrefs.mode, 'optional');
  assert.deepEqual(quality.bounds.relatedExpansion, {
    enabled: null,
    depth: null,
    maxCandidatesPerKeyword: null,
    minOverlap: null,
    minVolume: null,
    selectedRows: 0,
    explicitOmissionCount: null,
    omissionAccounting: 'not_persisted',
  });
  assert.deepEqual(quality.warnings.map((item) => item.code), ['GEO_UNKNOWN']);
});
