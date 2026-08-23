import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RunStore } from '../db/store.js';
import { loadConfig } from '../config/config.js';
import { runEnrichment, type EnrichmentHttpConfig, type EnrichmentPagesConfig, type EnrichmentSiteStructureConfig, type SsrfChecker } from './engine.js';
import { CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig } from './clustering.js';

const CLUSTERING_CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
};

const BASE_CONFIG = loadConfig({});

const allowTestSsrf: SsrfChecker = async () => ({ allowed: true });

let server: Server;
let baseUrl: string;
let testDomain: string;

before(() => {
  return new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`User-agent: *
Allow: /

Sitemap: ${baseUrl}/sitemap.xml
Sitemap: ${baseUrl}/sitemap2.xml
`);
      } else if (url === '/sitemap.xml') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${baseUrl}/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`);
      } else if (url === '/sitemap-pages.xml') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/page1</loc></url>
  <url><loc>${baseUrl}/page2</loc></url>
  <url><loc>${baseUrl}/page3</loc></url>
</urlset>`);
      } else if (url === '/sitemap2.xml') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/page4</loc></url>
  <url><loc>${baseUrl}/page5</loc></url>
</urlset>`);
      } else if (url === '/empty-robots') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('User-agent: *\nAllow: /\n');
      } else if (url === '/no-robots') {
        res.writeHead(404);
        res.end('Not found');
      } else if (url === '/malformed-sitemap') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end('not valid xml <<<');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>OK</body></html>');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      testDomain = `127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(() => {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

const TEST_KEYWORDS = [
  { keyword: 'test query', normalizedKeyword: 'test query', sourceRows: [1] },
  { keyword: 'test query two', normalizedKeyword: 'test query two', sourceRows: [2] },
  { keyword: 'test query three', normalizedKeyword: 'test query three', sourceRows: [3] },
  { keyword: 'test query four', normalizedKeyword: 'test query four', sourceRows: [4] },
  { keyword: 'test query five', normalizedKeyword: 'test query five', sourceRows: [5] },
];

const TEST_SHORTLIST = TEST_KEYWORDS.map((k) => k.keyword);

function createSourceStoreForDomains(runId: string, domains: string[]): RunStore {
  const store = RunStore.openInMemory();
  const configSnapshot = {
    ...BASE_CONFIG,
    cache: { ...BASE_CONFIG.cache, path: ':memory:' },
  };
  store.createRun({
    runId,
    configSnapshot,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'test.csv' },
    keywords: TEST_KEYWORDS,
  });

  const now = new Date().toISOString();
  const serpRows = domains.map((domain, i) => ({
    keyword: 'test query',
    position: i + 1,
    title: '',
    url: `https://${domain}/`,
    hostname: domain,
    registrableDomain: domain,
    dr: null,
    drStatus: 'not_attempted' as const,
    resultType: 'organic' as const,
  }));

  for (const kw of TEST_KEYWORDS) {
    store.commitKeyword(
      runId,
      {
        id: `k-${kw.normalizedKeyword}`,
        idx: TEST_KEYWORDS.indexOf(kw),
        keyword: kw.keyword,
        normalizedKeyword: kw.normalizedKeyword,
        sources: [{ type: 'seed', rowNumbers: kw.sourceRows }],
        status: 'completed',
        surfer: { volume: 100, cpc: 1.0, market: 'US', fetchedAt: now },
        google: { hl: 'en', gl: 'us', pageUrl: baseUrl, detectedLocation: null, geoWarning: false },
        error: null,
        collectedAt: now,
        cacheStatus: 'refreshed',
      },
      kw.keyword === 'test query' ? serpRows : [],
    );
  }

  return store;
}

const HTTP_CONFIG: EnrichmentHttpConfig = {
  enabled: true,
  maxRedirects: 5,
  timeoutMs: 5000,
  maxBytes: 10_000,
  maxTextBytes: 5000,
  userAgent: 'Test/1.0',
  respectRetryAfter: true,
  minDelayMs: 0,
  maxDelayMs: 0,
  maxRetries: 0,
  baseRetryDelayMs: 100,
};

const PAGES_CONFIG: EnrichmentPagesConfig = {
  enabled: true,
  topUrlsPerKeyword: 3,
  includeMainText: false,
  mainTextMaxChars: 5000,
};

const SITE_STRUCTURE_CONFIG: EnrichmentSiteStructureConfig = {
  enabled: true,
  maxSitemapFiles: 10,
  maxUrlsPerSitemap: 100,
  maxSampleUrls: 50,
  maxDomains: 30,
};

test('site_structure module: handles HTTPS failures gracefully against HTTP-only server', async () => {
  const runId = 'ss-https-fail';
  const sourceStore = createSourceStoreForDomains(runId, [testDomain]);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'ss-https-fail-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'ss-enrichment-https-fail',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['site_structure'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: allowTestSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result);
  assert.ok(outcome.result!.siteStructure);
  assert.equal(outcome.result!.siteStructure!.length, 1);

  const record = outcome.result!.siteStructure![0]!;
  assert.equal(record.domain, testDomain);
  assert.ok(record.errors.length > 0, 'Should have errors from HTTPS failures');

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('site_structure module: handles empty robots.txt', async () => {
  const runId = 'ss-empty-robots';
  const sourceStore = createSourceStoreForDomains(runId, [testDomain]);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'ss-empty-robots-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'ss-enrichment-empty-robots',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['site_structure'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: allowTestSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result!.siteStructure);

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('site_structure module: handles missing robots.txt with fallback', async () => {
  const noRobotsDomain = `no-robots.${testDomain}`;
  const runId = 'ss-no-robots';

  const store = RunStore.openInMemory();
  const configSnapshot = { ...BASE_CONFIG, cache: { ...BASE_CONFIG.cache, path: ':memory:' } };
  store.createRun({
    runId,
    configSnapshot,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'test.csv' },
    keywords: [{ keyword: 'test', normalizedKeyword: 'test', sourceRows: [1] }],
  });
  const now = new Date().toISOString();
  store.commitKeyword(runId, {
    id: 'k1', idx: 0, keyword: 'test', normalizedKeyword: 'test',
    sources: [{ type: 'seed', rowNumbers: [1] }], status: 'completed',
    surfer: { volume: 100, cpc: 1.0, market: 'US', fetchedAt: now },
    google: { hl: 'en', gl: 'us', pageUrl: baseUrl, detectedLocation: null, geoWarning: false },
    error: null, collectedAt: now, cacheStatus: 'refreshed',
  }, [{ keyword: 'test', position: 1, title: '', url: `https://${noRobotsDomain}/`, hostname: noRobotsDomain, registrableDomain: noRobotsDomain, dr: null, drStatus: 'not_attempted', resultType: 'organic' }]);

  const enrichmentDir = await mkdtemp(join(tmpdir(), 'ss-no-robots-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'ss-enrichment-no-robots',
    sourceStoreOrPath: store,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['site_structure'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: allowTestSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result!.siteStructure);

  store.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('site_structure module: handles malformed sitemap XML', async () => {
  const malformedDomain = `malformed.${testDomain}`;
  const runId = 'ss-malformed';

  const store = RunStore.openInMemory();
  const configSnapshot = { ...BASE_CONFIG, cache: { ...BASE_CONFIG.cache, path: ':memory:' } };
  store.createRun({
    runId,
    configSnapshot,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'test.csv' },
    keywords: [{ keyword: 'test', normalizedKeyword: 'test', sourceRows: [1] }],
  });
  const now = new Date().toISOString();
  store.commitKeyword(runId, {
    id: 'k1', idx: 0, keyword: 'test', normalizedKeyword: 'test',
    sources: [{ type: 'seed', rowNumbers: [1] }], status: 'completed',
    surfer: { volume: 100, cpc: 1.0, market: 'US', fetchedAt: now },
    google: { hl: 'en', gl: 'us', pageUrl: baseUrl, detectedLocation: null, geoWarning: false },
    error: null, collectedAt: now, cacheStatus: 'refreshed',
  }, [{ keyword: 'test', position: 1, title: '', url: `https://${malformedDomain}/`, hostname: malformedDomain, registrableDomain: malformedDomain, dr: null, drStatus: 'not_attempted', resultType: 'organic' }]);

  const enrichmentDir = await mkdtemp(join(tmpdir(), 'ss-malformed-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'ss-enrichment-malformed',
    sourceStoreOrPath: store,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['site_structure'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: allowTestSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result!.siteStructure);

  store.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});
