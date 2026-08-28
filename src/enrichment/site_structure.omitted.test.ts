import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { loadConfig } from '../config/config.js';
import { runEnrichment } from './engine.js';
import { CLUSTERING_ALGORITHM_VERSION } from './clustering.js';

const KEYWORDS = ['alpha tool', 'beta tool', 'gamma tool', 'delta tool', 'epsilon tool'];

function createSourceStore(runId: string): RunStore {
  const store = RunStore.openInMemory();
  const config = loadConfig({});
  store.createRun({
    runId,
    configSnapshot: { ...config, cache: { ...config.cache, path: ':memory:' } },
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'test.csv' },
    keywords: KEYWORDS.map((keyword, index) => ({
      keyword,
      normalizedKeyword: keyword,
      sourceRows: [index + 1],
    })),
  });

  const now = '2026-01-01T00:00:00.000Z';
  for (const keyword of store.loadKeywords(runId)) {
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
      keyword.idx === 0
        ? [{
            keyword: keyword.keyword,
            position: 1,
            title: 'Example',
            url: 'https://omitted.example/',
            hostname: 'omitted.example',
            registrableDomain: 'omitted.example',
            dr: null,
            drStatus: 'not_attempted',
            resultType: 'organic',
          }]
        : [],
    );
  }
  return store;
}

test('site_structure publishes domains omitted by maxDomains from persisted targets', async () => {
  const runId = 'site-structure-omitted-source';
  const enrichmentId = 'site-structure-omitted-enrichment';
  const sourceStore = createSourceStore(runId);
  const enrichmentStore = RunStore.openInMemory();
  const outputDirectory = await mkdtemp(join(tmpdir(), 'site-structure-omitted-'));

  try {
    const outcome = await runEnrichment({
      enrichmentId,
      sourceStoreOrPath: sourceStore,
      sourceRunId: runId,
      enrichmentStore,
      enrichmentDirectory: outputDirectory,
      modules: ['site_structure'],
      shortlist: KEYWORDS,
      config: {
        clusters: {
          topN: 10,
          edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
          algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
        },
      },
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
      logger: () => {},
    });

    assert.equal(outcome.kind, 'completed');
    assert.deepEqual(outcome.result?.siteStructure, []);

    const targets = enrichmentStore.loadSiteStructureTargets(enrichmentId);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.domain, 'omitted.example');
    assert.match(targets[0]?.error ?? '', /^omitted:/);

    const csv = await readFile(join(outputDirectory, 'site-structure.csv'), 'utf8');
    assert.match(csv, /omitted\.example/);
    assert.match(csv, /true,domain_cap/);

    const json = JSON.parse(await readFile(join(outputDirectory, 'site-structure.json'), 'utf8')) as {
      domainCount: number;
      omittedCount: number;
      discoveredDomainCount: number;
      omitted: Array<{ domain: string; reason: string }>;
    };
    assert.equal(json.domainCount, 0);
    assert.equal(json.omittedCount, 1);
    assert.equal(json.discoveredDomainCount, 1);
    assert.deepEqual(json.omitted, [{ domain: 'omitted.example', reason: 'domain_cap' }]);
  } finally {
    sourceStore.close();
    enrichmentStore.close();
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
