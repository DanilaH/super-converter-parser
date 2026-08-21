import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyDomainRatings,
  executeRun,
  type CollectKeywordFn,
  type EngineHooks,
} from './engine.js';
import { RunStore } from '../db/store.js';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import type { CollectionResult } from '../browser/collect.js';
import type { KeywordRecord } from './run.js';
import type { SerpResult } from '../google/serp.js';
import type { AhrefsClient, DomainRatingResult } from '../ahrefs/client.js';

const CONFIG = loadConfig({});

function serpRow(url: string, domain: string, dr: number | null = null): SerpResult {
  return {
    keyword: 'compare lists',
    position: 1,
    title: 't',
    url,
    hostname: domain,
    registrableDomain: domain,
    dr,
    drStatus: null,
    resultType: 'organic',
  };
}

function okRating(domain: string, dr: number): DomainRatingResult {
  return { domain, dr, fetchedAt: new Date().toISOString(), source: 'ahrefs', status: 'ok', error: null };
}

test('resolves DR once per unique domain and writes it into every matching row', async () => {
  const calls: string[] = [];
  const ahrefs: AhrefsClient = async (domain: string) => {
    calls.push(domain);
    return okRating(domain, domain === 'a.com' ? 55 : 22);
  };
  const cache = CacheStore.openInMemory();
  const serpRows = [
    serpRow('https://a.com/1', 'a.com'),
    serpRow('https://a.com/2', 'a.com'),
    serpRow('https://b.com/1', 'b.com'),
  ];

  await applyDomainRatings({
    serpRows,
    ahrefs,
    domainCache: cache,
    config: CONFIG,
    now: () => Date.now(),
    sleep: async () => undefined,
    logger: () => undefined,
  });

  assert.equal(calls.length, 2, 'one API call per distinct domain');
  assert.deepEqual(
    serpRows.map((row) => row.dr),
    [55, 55, 22],
  );
});

test('reuses the domain cache so a repeated domain is not re-fetched', async () => {
  const calls: string[] = [];
  const ahrefs: AhrefsClient = async (domain: string) => {
    calls.push(domain);
    return okRating(domain, 40);
  };
  const cache = CacheStore.openInMemory();

  const first = [serpRow('https://a.com/1', 'a.com'), serpRow('https://b.com/1', 'b.com')];
  const second = [serpRow('https://a.com/2', 'a.com'), serpRow('https://b.com/2', 'b.com')];

  const params = {
    ahrefs,
    domainCache: cache,
    config: CONFIG,
    now: () => Date.now(),
    sleep: async () => undefined,
    logger: () => undefined,
  };

  await applyDomainRatings({ ...params, serpRows: first });
  await applyDomainRatings({ ...params, serpRows: second });

  assert.equal(calls.length, 2, 'second pass served entirely from the domain cache');
  assert.deepEqual(
    second.map((row) => row.dr),
    [40, 40],
  );
});

test('skips enrichment when the client is absent', async () => {
  const cache = CacheStore.openInMemory();
  const serpRows = [serpRow('https://a.com/1', 'a.com')];
  await applyDomainRatings({
    serpRows,
    ahrefs: null,
    domainCache: cache,
    config: CONFIG,
    now: () => Date.now(),
    sleep: async () => undefined,
    logger: () => undefined,
  });
  assert.equal(serpRows[0]!.dr, null);
});

test('records not_found ratings as null DR without throwing', async () => {
  const calls: string[] = [];
  const ahrefs: AhrefsClient = async (domain: string) => {
    calls.push(domain);
    return { domain, dr: null, fetchedAt: new Date().toISOString(), source: 'ahrefs', status: 'not_found', error: null };
  };
  const cache = CacheStore.openInMemory();
  const serpRows = [serpRow('https://ghost.com/1', 'ghost.com')];
  await applyDomainRatings({
    serpRows,
    ahrefs,
    domainCache: cache,
    config: CONFIG,
    now: () => Date.now(),
    sleep: async () => undefined,
    logger: () => undefined,
  });
  assert.equal(calls.length, 1);
  assert.equal(serpRows[0]!.dr, null);
});

// --- End-to-end path through executeRun ---

const KEYWORDS: SeedKeyword[] = buildSeedKeywords([
  { keyword: 'compare lists', rowNumber: 1 },
  { keyword: 'best office chairs', rowNumber: 2 },
]);

function makeHooks(): EngineHooks {
  return {
    sleep: async () => undefined,
    now: () => Date.now(),
    random: () => 0.5,
    logger: () => undefined,
    pauseRequested: () => false,
  };
}

function serpRowsFor(keyword: string): SerpResult[] {
  return [
    {
      keyword,
      position: 1,
      title: 't1',
      url: 'https://example.com/1',
      hostname: 'example.com',
      registrableDomain: 'example.com',
      dr: null,
      drStatus: null,
      resultType: 'organic',
    },
    {
      keyword,
      position: 2,
      title: 't2',
      url: 'https://other.com/1',
      hostname: 'other.com',
      registrableDomain: 'other.com',
      dr: null,
      drStatus: null,
      resultType: 'organic',
    },
  ];
}

function okCollect(record: KeywordRecord): CollectionResult {
  return {
    record: {
      ...record,
      status: 'completed',
      surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: new Date().toISOString() },
      google: { hl: 'en', gl: 'us', pageUrl: 'u', detectedLocation: null, geoWarning: false },
      error: null,
    },
    serpRows: serpRowsFor(record.normalizedKeyword),
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  };
}

test('executeRun looks up DR once per unique domain across keywords and persists it', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const calls: string[] = [];
  const ahrefs: AhrefsClient = async (domain: string) => {
    calls.push(domain);
    return okRating(domain, 70);
  };
  const collect: CollectKeywordFn = async (record) => okCollect(record);

  const dir = await mkdtemp(join(tmpdir(), 'run-dr-'));
  const runDirectory = join(dir, 'run');
  const debugRoot = join(dir, 'debug');
  await mkdir(runDirectory, { recursive: true });
  await mkdir(debugRoot, { recursive: true });

  await executeRun({
    store,
    runId: 'run-1',
    mode: 'fresh',
    keywords: KEYWORDS,
    config: CONFIG,
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    runDirectory,
    debugRoot,
    collect,
    hooks: makeHooks(),
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set<string>() },
    ahrefs: { apiKey: 'k', client: ahrefs },
  });

  assert.equal(calls.length, 2, 'two keywords share example.com + other.com => 2 unique domains');
  const serp = store.loadSerpRows('run-1');
  assert.equal(serp.length, 4);
  assert.ok(serp.every((row) => row.dr === 70), 'every persisted SERP row carries the resolved DR');
});
