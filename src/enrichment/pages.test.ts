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

const allowTestSsrf: SsrfChecker = async (url) => {
  if (url.includes('192.168.1.1') || url.includes('10.0.0.1')) {
    return { allowed: false, reason: 'Blocked IP' };
  }
  return { allowed: true };
};

const blockPrivateSsrf: SsrfChecker = async (url) => {
  if (url.includes('192.168.1.1') || url.includes('10.') || url.includes('127.0.0.1')) {
    return { allowed: false, reason: 'Blocked IP' };
  }
  return { allowed: true };
};

let server: Server;
let baseUrl: string;
let testDomain: string;

before(() => {
  return new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/page1') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <title>Test Page One</title>
  <meta name="description" content="First test page">
  <link rel="canonical" href="${baseUrl}/page1">
  <script type="application/ld+json">{"@type": "Article", "headline": "Test"}</script>
</head>
<body>
  <h1>Page One Heading</h1>
  <p>This is test content for page one with several words.</p>
  <form>
    <input type="text" name="q">
    <input type="file" name="upload">
    <textarea name="comment"></textarea>
    <button type="submit">Submit</button>
  </form>
</body></html>`);
      } else if (url === '/page2') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>Page Two</title></head>
<body><h1>Second Page</h1><p>Content here.</p></body></html>`);
      } else if (url === '/non-html') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end('fake pdf content');
      } else if (url === '/malformed-jsonld') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><head><title>Bad JSON-LD</title>
<script type="application/ld+json">{invalid json</script>
<script type="application/ld+json">{"@type": "ValidType"}</script>
</head><body><h1>Test</h1></body></html>`);
      } else if (url === '/redirect-target') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Redirect Target</title></head><body><h1>Final</h1></body></html>');
      } else if (url === '/redirect-to-redirect-target') {
        res.writeHead(302, { Location: '/redirect-target' });
        res.end();
      } else if (url === '/redirect-to-private') {
        res.writeHead(302, { Location: 'http://192.168.1.1/admin' });
        res.end();
      } else if (url === '/slow-page') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Slow</h1></body></html>');
        }, 500);
      } else if (url === '/oversized-page') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('x'.repeat(50));
      } else if (url === '/no-title') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>No title here</h1></body></html>');
      } else {
        res.writeHead(404);
        res.end('Not found');
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

function createSourceStoreWithSerp(runId: string, urls: string[]): RunStore {
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
  const serpRows = urls.map((url, i) => ({
    keyword: 'test query',
    position: i + 1,
    title: '',
    url,
    hostname: new URL(url).hostname,
    registrableDomain: testDomain,
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
  timeoutMs: 2000,
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
  topUrlsPerKeyword: 5,
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

test('pages module: extracts page data from HTML', async () => {
  const runId = 'pages-test-1';
  const sourceStore = createSourceStoreWithSerp(runId, [`${baseUrl}/page1`, `${baseUrl}/page2`]);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'pages-test-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'pages-enrichment-1',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['pages'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: allowTestSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result!.pages);
  assert.equal(outcome.result!.pages!.length, 2);

  const page1 = outcome.result!.pages!.find((p) => p.url === `${baseUrl}/page1`);
  assert.ok(page1);
  assert.equal(page1!.title, 'Test Page One');
  assert.equal(page1!.metaDescription, 'First test page');
  assert.equal(page1!.h1, 'Page One Heading');
  assert.equal(page1!.canonical, `${baseUrl}/page1`);
  assert.equal(page1!.language, 'en');
  assert.ok(page1!.wordCount && page1!.wordCount > 0);
  assert.equal(page1!.forms.formCount, 1);
  assert.equal(page1!.forms.inputCount, 2);
  assert.equal(page1!.forms.fileInputCount, 1);
  assert.equal(page1!.forms.textareaCount, 1);
  assert.equal(page1!.forms.buttonCount, 1);
  assert.deepEqual(page1!.structuredDataTypes, ['Article']);
  assert.equal(page1!.fetchStatus, 'ok');

  const page2 = outcome.result!.pages!.find((p) => p.url === `${baseUrl}/page2`);
  assert.ok(page2);
  assert.equal(page2!.title, 'Page Two');
  assert.equal(page2!.fetchStatus, 'ok');

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('pages module: handles non-HTML content', async () => {
  const runId = 'pages-non-html';
  const sourceStore = createSourceStoreWithSerp(runId, [`${baseUrl}/non-html`]);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'pages-non-html-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'pages-enrichment-non-html',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['pages'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: allowTestSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result!.pages);
  assert.equal(outcome.result!.pages!.length, 1);
  assert.equal(outcome.result!.pages![0]!.fetchStatus, 'non_html');
  assert.equal(outcome.result!.pages![0]!.title, null);

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('pages module: handles malformed JSON-LD gracefully', async () => {
  const runId = 'pages-malformed-jsonld';
  const sourceStore = createSourceStoreWithSerp(runId, [`${baseUrl}/malformed-jsonld`]);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'pages-malformed-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'pages-enrichment-malformed',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['pages'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: allowTestSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result!.pages);
  assert.equal(outcome.result!.pages![0]!.fetchStatus, 'ok');
  assert.deepEqual(outcome.result!.pages![0]!.structuredDataTypes, ['ValidType']);

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('pages module: follows redirects and captures chain', async () => {
  const runId = 'pages-redirect';
  const sourceStore = createSourceStoreWithSerp(runId, [`${baseUrl}/redirect-to-redirect-target`]);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'pages-redirect-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'pages-enrichment-redirect',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['pages'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: allowTestSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result!.pages);
  const page = outcome.result!.pages![0]!;
  assert.equal(page.fetchStatus, 'ok');
  assert.equal(page.finalUrl, `${baseUrl}/redirect-target`);
  assert.equal(page.redirectCount, 1);
  assert.equal(page.title, 'Redirect Target');

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('pages module: blocks SSRF redirect to private IP', async () => {
  const runId = 'pages-ssrf';
  const sourceStore = createSourceStoreWithSerp(runId, [`${baseUrl}/redirect-to-private`]);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'pages-ssrf-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'pages-enrichment-ssrf',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['pages'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: blockPrivateSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result!.pages);
  const page = outcome.result!.pages![0]!;
  assert.equal(page.fetchStatus, 'blocked');
  assert.match(page.fetchError!, /SSRF blocked/);

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('pages module: handles timeout', async () => {
  const runId = 'pages-timeout';
  const sourceStore = createSourceStoreWithSerp(runId, [`${baseUrl}/slow-page`]);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'pages-timeout-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'pages-enrichment-timeout',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['pages'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: { ...HTTP_CONFIG, timeoutMs: 100 },
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: allowTestSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result!.pages);
  const page = outcome.result!.pages![0]!;
  assert.equal(page.fetchStatus, 'timeout');

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('pages module: aborts oversized body', async () => {
  const runId = 'pages-oversized';
  const sourceStore = createSourceStoreWithSerp(runId, [`${baseUrl}/oversized-page`]);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'pages-oversized-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'pages-enrichment-oversized',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['pages'],
    shortlist: TEST_SHORTLIST,
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: { ...HTTP_CONFIG, maxBytes: 20 },
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    ssrfChecker: allowTestSsrf,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result!.pages);
  const page = outcome.result!.pages![0]!;
  assert.equal(page.fetchStatus, 'oversized');
  assert.match(page.fetchError!, /exceeded/);

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});
