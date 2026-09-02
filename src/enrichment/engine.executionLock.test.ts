import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunStore } from '../db/store.js';
import { ResearchError } from '../shared/errors.js';
import type { EnrichmentOptions } from './engine.js';
import { acquireEnrichmentExecutionLock } from './executionLock.js';
import { runEnrichmentLocked } from './runLocked.js';

function blockedOptions(
  enrichmentStore: RunStore,
  enrichmentDirectory: string,
): EnrichmentOptions {
  return {
    enrichmentId: 'locked-enrichment',
    sourceRunId: 'source-run',
    sourceStoreOrPath: enrichmentStore,
    enrichmentStore,
    enrichmentDirectory,
    modules: ['clusters'],
    config: {},
    httpConfig: {
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
    },
    pagesConfig: {
      enabled: true,
      topUrlsPerKeyword: 3,
      includeMainText: false,
      mainTextMaxChars: 5000,
    },
    siteStructureConfig: {
      enabled: true,
      maxSitemapFiles: 10,
      maxUrlsPerSitemap: 100,
      maxSampleUrls: 50,
      maxDomains: 30,
    },
    logger: () => {},
  };
}

test('runEnrichmentLocked rejects a live concurrent generation before mutating durable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enrichment-engine-lock-'));
  const enrichmentDirectory = join(root, 'enrichment');
  const enrichmentStore = RunStore.openInMemory();
  const release = await acquireEnrichmentExecutionLock(enrichmentDirectory, 'locked-enrichment');

  try {
    await assert.rejects(
      runEnrichmentLocked(blockedOptions(enrichmentStore, enrichmentDirectory)),
      (error: unknown) => error instanceof ResearchError
        && error.code === 'OUTPUT_WRITE_ERROR'
        && /already running/i.test(error.message),
    );
    assert.equal(enrichmentStore.loadEnrichmentRun('locked-enrichment'), null);
  } finally {
    await release();
    enrichmentStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
