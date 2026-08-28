import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import type { FirstSeenClient } from '../firstseen/types.js';
import type { RdapClient } from '../rdap/types.js';
import { buildDomainAgeConfigSnapshot } from '../runs/domainAge.js';
import { runEnrichment, type EnrichmentOptions } from './engine.js';

const KEYWORDS = ['alpha tool', 'beta tool', 'gamma tool', 'delta tool', 'epsilon tool'];
const BASE_CONFIG = loadConfig({});

function createSourceStore(runId: string): RunStore {
  const store = RunStore.openInMemory();
  store.createRun({
    runId,
    configSnapshot: { ...BASE_CONFIG, cache: { ...BASE_CONFIG.cache, path: ':memory:' } },
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: KEYWORDS.map((keyword, index) => ({
      keyword,
      normalizedKeyword: keyword,
      sourceRows: [index + 1],
    })),
  });

  const now = '2026-01-01T00:00:00.000Z';
  for (const keyword of store.loadKeywords(runId)) {
    const domain = `domain-${keyword.idx + 1}.com`;
    store.commitKeyword(
      runId,
      {
        ...keyword,
        status: 'completed',
        surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: now },
        google: { hl: 'en', gl: 'us', pageUrl: 'https://www.google.com/', detectedLocation: null, geoWarning: false },
        error: null,
        collectedAt: now,
        cacheStatus: 'refreshed',
      },
      [{
        keyword: keyword.keyword,
        position: 1,
        title: 'Example',
        url: `https://${domain}/`,
        hostname: domain,
        registrableDomain: domain,
        dr: null,
        drStatus: 'not_attempted',
        resultType: 'organic',
      }],
    );
  }
  return store;
}

const rdapClient: RdapClient = async (domain) => ({
  domain,
  registrationDate: '2010-01-01T00:00:00Z',
  status: 'ok',
  error: null,
  source: 'rdap',
  rule: 'test',
  events: [],
  isRedacted: false,
  fetchedAt: '2026-01-01T00:00:00.000Z',
  requestCount: 1,
  httpStatus: 200,
});

const firstSeenClient: FirstSeenClient = async (domain) => ({
  domain,
  firstSeenDate: '2011-01-01T00:00:00Z',
  status: 'ok',
  error: null,
  source: 'wayback',
  sourceReason: null,
  fetchedAt: '2026-01-01T00:00:00.000Z',
  requestCount: 1,
  httpStatus: 200,
});

function baseOptions(
  runId: string,
  enrichmentId: string,
  sourceStore: RunStore,
  enrichmentStore: RunStore,
  enrichmentDirectory: string,
  cacheStore: CacheStore,
  logs: string[],
): Omit<EnrichmentOptions, 'modules'> {
  return {
    enrichmentId,
    sourceRunId: runId,
    sourceStoreOrPath: sourceStore,
    enrichmentStore,
    enrichmentDirectory,
    shortlist: KEYWORDS,
    config: {},
    domainAgeConfig: buildDomainAgeConfigSnapshot(BASE_CONFIG),
    cacheStore,
    rdapClient,
    firstSeenClient,
    httpConfig: {
      enabled: true,
      maxRedirects: 5,
      timeoutMs: 100,
      maxBytes: 10_000,
      maxTextBytes: 5_000,
      userAgent: 'Test/1.0',
      respectRetryAfter: true,
      minDelayMs: 0,
      maxDelayMs: 0,
      maxRetries: 0,
      baseRetryDelayMs: 0,
    },
    pagesConfig: {
      enabled: false,
      topUrlsPerKeyword: 1,
      includeMainText: false,
      mainTextMaxChars: 1_000,
    },
    siteStructureConfig: {
      enabled: true,
      maxSitemapFiles: 1,
      maxUrlsPerSitemap: 1,
      maxSampleUrls: 1,
      maxDomains: 0,
    },
    logger: (line) => logs.push(line),
  };
}

test('combined domain modules publish module-scoped counts without ambiguous domainCount', async () => {
  const runId = 'summary-source';
  const enrichmentId = 'summary-combined';
  const sourceStore = createSourceStore(runId);
  const enrichmentStore = RunStore.openInMemory();
  const cacheStore = CacheStore.openInMemory();
  const outputDirectory = await mkdtemp(join(tmpdir(), 'enrichment-summary-'));
  const logs: string[] = [];

  try {
    const outcome = await runEnrichment({
      ...baseOptions(runId, enrichmentId, sourceStore, enrichmentStore, outputDirectory, cacheStore, logs),
      modules: ['domain_age', 'site_structure'],
    });
    assert.equal(outcome.kind, 'completed');

    const status = JSON.parse(await readFile(join(outputDirectory, 'status.json'), 'utf8')) as {
      summary: Record<string, number>;
    };
    assert.equal(status.summary.siteStructureDomainCount, 0);
    assert.equal(status.summary.siteStructureOmittedCount, 5);
    assert.equal(status.summary.siteStructureDiscoveredDomainCount, 5);
    assert.equal(status.summary.domainAgeDomainCount, 5);
    assert.equal(status.summary.domainAgeOmittedCount, 0);
    assert.equal(status.summary.domainAgeDiscoveredDomainCount, 5);
    assert.equal('domainCount' in status.summary, false);
    assert.ok(logs.some((line) => line.includes('5 domain-age records processed (0 errors)')));
  } finally {
    sourceStore.close();
    enrichmentStore.close();
    cacheStore.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('single domain_age run keeps legacy generic counts alongside explicit domain-age counts', async () => {
  const runId = 'summary-single-source';
  const enrichmentId = 'summary-single';
  const sourceStore = createSourceStore(runId);
  const enrichmentStore = RunStore.openInMemory();
  const cacheStore = CacheStore.openInMemory();
  const outputDirectory = await mkdtemp(join(tmpdir(), 'enrichment-summary-single-'));
  const logs: string[] = [];

  try {
    const outcome = await runEnrichment({
      ...baseOptions(runId, enrichmentId, sourceStore, enrichmentStore, outputDirectory, cacheStore, logs),
      modules: ['domain_age'],
    });
    assert.equal(outcome.kind, 'completed');

    const status = JSON.parse(await readFile(join(outputDirectory, 'status.json'), 'utf8')) as {
      summary: Record<string, number>;
    };
    assert.equal(status.summary.domainAgeDomainCount, 5);
    assert.equal(status.summary.domainCount, 5);
    assert.equal(status.summary.domainOmitted, 0);
    assert.equal(status.summary.domainsDiscovered, 5);
  } finally {
    sourceStore.close();
    enrichmentStore.close();
    cacheStore.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
