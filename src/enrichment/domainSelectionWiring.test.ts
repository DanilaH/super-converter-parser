import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { DOMAIN_SELECTION_POLICY_V1 } from './domainSelection.js';
import {
  runEnrichment,
  type EnrichmentHttpConfig,
  type EnrichmentPagesConfig,
  type EnrichmentSiteStructureConfig,
} from './engine.js';

const HTTP_CONFIG: EnrichmentHttpConfig = {
  enabled: true,
  maxRedirects: 5,
  timeoutMs: 15_000,
  maxBytes: 2_000_000,
  maxTextBytes: 500_000,
  userAgent: 'Test/1.0',
  respectRetryAfter: true,
  minDelayMs: 0,
  maxDelayMs: 0,
  maxRetries: 2,
  baseRetryDelayMs: 1000,
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

const SHORTLIST = ['one', 'two', 'three', 'four', 'five'];

function createSourceStore(runId: string): RunStore {
  const store = RunStore.openInMemory();
  store.createRun({
    runId,
    configSnapshot: loadConfig({}),
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'test.csv' },
    keywords: SHORTLIST.map((keyword, index) => ({
      keyword,
      normalizedKeyword: keyword,
      sourceRows: [index + 1],
    })),
  });
  return store;
}

test('fresh bounded enrichment persists entrant-v1 before work starts', async () => {
  const runId = 'fresh-selection-source';
  const sourceStore = createSourceStore(runId);
  const directory = await mkdtemp(join(tmpdir(), 'fresh-domain-selection-'));
  const enrichmentStore = RunStore.open(join(directory, 'enrichment.sqlite'));

  try {
    const outcome = await runEnrichment({
      enrichmentId: 'fresh-selection-enrichment',
      sourceStoreOrPath: sourceStore,
      sourceRunId: runId,
      enrichmentStore,
      enrichmentDirectory: directory,
      modules: ['site_structure'],
      shortlist: SHORTLIST,
      config: {},
      httpConfig: HTTP_CONFIG,
      pagesConfig: PAGES_CONFIG,
      siteStructureConfig: SITE_STRUCTURE_CONFIG,
      logger: () => {},
      signal: { cancelled: true },
    });

    assert.equal(outcome.kind, 'paused');
    assert.equal(
      enrichmentStore.loadEnrichmentRun('fresh-selection-enrichment')?.config.domain_selection?.algorithmVersion,
      DOMAIN_SELECTION_POLICY_V1,
    );
  } finally {
    sourceStore.close();
    enrichmentStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy bounded enrichment resume does not backfill entrant-v1', async () => {
  const runId = 'legacy-selection-source';
  const sourceStore = createSourceStore(runId);
  const directory = await mkdtemp(join(tmpdir(), 'legacy-domain-selection-'));
  const enrichmentStore = RunStore.open(join(directory, 'enrichment.sqlite'));
  const enrichmentId = 'legacy-selection-enrichment';

  try {
    enrichmentStore.createEnrichmentRun({
      enrichmentId,
      sourceRunId: runId,
      modules: ['site_structure'],
      config: JSON.stringify({
        http: HTTP_CONFIG,
        pages: PAGES_CONFIG,
        site_structure: SITE_STRUCTURE_CONFIG,
      }),
      sourceRunDirectory: `runs/${runId}`,
      enrichmentDirectory: directory,
      shortlistKeywords: SHORTLIST,
    });

    const persistedBeforeResume = enrichmentStore.loadEnrichmentRun(enrichmentId);
    assert.equal(persistedBeforeResume?.config.domain_selection, undefined);

    const outcome = await runEnrichment({
      enrichmentId,
      sourceStoreOrPath: sourceStore,
      sourceRunId: runId,
      enrichmentStore,
      enrichmentDirectory: directory,
      modules: ['site_structure'],
      shortlist: SHORTLIST,
      config: persistedBeforeResume?.config ?? {},
      httpConfig: HTTP_CONFIG,
      pagesConfig: PAGES_CONFIG,
      siteStructureConfig: SITE_STRUCTURE_CONFIG,
      logger: () => {},
      signal: { cancelled: true },
      resume: true,
    });

    assert.equal(outcome.kind, 'paused');
    assert.equal(enrichmentStore.loadEnrichmentRun(enrichmentId)?.config.domain_selection, undefined);
  } finally {
    sourceStore.close();
    enrichmentStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
