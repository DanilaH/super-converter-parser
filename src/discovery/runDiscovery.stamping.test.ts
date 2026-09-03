import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser, BrowserContext } from 'playwright-core';
import { RunStore } from '../db/store.js';
import type { CollectionResult } from '../browser/collect.js';
import type { KeywordRecord } from '../runs/run.js';
import { runDiscovery, type CliDeps } from './runDiscovery.js';

function collected(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: { volume: 10, cpc: null, market: 'US', fetchedAt: '2026-09-03T00:00:00.000Z' },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=x',
        detectedLocation: null,
        geoWarning: false,
      },
      error: null,
    },
    serpRows: [],
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  };
}

test('public fresh discovery stamps V1 admission into the durable config snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'discovery-stamp-v1-'));
  const seedsPath = join(root, 'seeds.csv');
  const outputRoot = join(root, 'results');
  await writeFile(seedsPath, 'keyword\njson formatter\n', 'utf8');

  const fakeContext = {} as BrowserContext;
  const fakeBrowser = {
    contexts: () => [fakeContext],
    close: async () => undefined,
  } as unknown as Browser;
  const deps: CliDeps = {
    connect: async () => fakeBrowser,
    preflight: async () => undefined,
    collect: async (_context, _config, keyword) => collected(keyword),
    collectRelated: async (_context, _config, keyword) => ({
      related: collected(keyword).related,
      debugArtifactPath: null,
    }),
  };

  const result = await runDiscovery(
    {
      input: { kind: 'seeds', path: seedsPath },
      outputRoot,
      expand: true,
    },
    deps,
    {
      CACHE_DB_PATH: join(root, 'cache.sqlite'),
      CDP_URL: 'http://127.0.0.1:9333',
    },
  );

  assert.equal(result.exitCode, 0);
  assert.ok(result.discoveryDirectory);
  const store = RunStore.open(join(result.discoveryDirectory, 'run.sqlite'));
  const run = store.loadRun(result.runId!);
  assert.equal(
    (run?.configSnapshot.expansion as { admissionVersion?: string } | undefined)?.admissionVersion,
    'v1',
  );
  store.close();
});
