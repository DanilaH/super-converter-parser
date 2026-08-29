import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config/config.js';
import type { StoredDomain, StoredRun } from '../db/store.js';
import type { AhrefsSummary } from './engine.js';
import { buildRunQuality } from './runQuality.js';

const CONFIG = loadConfig({});

function run(): StoredRun {
  return {
    runId: 'quality-summary',
    state: 'completed',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T01:23:45.000Z',
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    configSnapshot: CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.4.0' },
    lookups: 0,
    pauseReason: null,
    forceRefresh: false,
    refreshKeywords: [],
  };
}

function domain(): StoredDomain {
  return {
    runId: 'quality-summary',
    domain: 'example.com',
    dr: 10,
    status: 'ok',
    error: null,
    source: 'fresh',
    fetchedAt: '2026-08-29T01:00:00.000Z',
    firstSeenKeyword: 'example',
    firstSeenKeywordIdx: 0,
    firstSeenPosition: 1,
  };
}

function summary(discovered: number): AhrefsSummary {
  return {
    mode: 'optional',
    state: 'complete',
    discovered,
    attempted: discovered,
    notAttempted: 0,
    cache: 0,
    fresh: discovered,
    ok: discovered,
    notFound: 0,
    error: 0,
    numericCoverage: discovered,
    requireAhrefs: false,
  };
}

test('tracker summary state is exposed only when its denominator matches durable domains', () => {
  const sourceRun = run();
  const matching = buildRunQuality({
    run: sourceRun,
    state: 'completed',
    keywords: [],
    serpRows: [],
    relatedKeywords: [],
    domains: [domain()],
    ahrefs: summary(1),
  });
  assert.equal(matching.sources.ahrefs.summaryState, 'complete');
  assert.equal(matching.runStateUpdatedAt, sourceRun.updatedAt);

  const mismatched = buildRunQuality({
    run: sourceRun,
    state: 'completed',
    keywords: [],
    serpRows: [],
    relatedKeywords: [],
    domains: [domain()],
    ahrefs: summary(0),
  });
  assert.equal(mismatched.sources.ahrefs.summaryState, null);
  assert.equal(mismatched.sources.ahrefs.statuses.ok, 1, 'durable domain status remains authoritative');
});
