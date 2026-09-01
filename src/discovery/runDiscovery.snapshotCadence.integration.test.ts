import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import type { CollectionResult } from '../browser/collect.js';
import type { ResearchConfig } from '../config/config.js';
import type { KeywordRecord } from '../runs/run.js';
import { runDiscovery, type CliDeps } from './runDiscovery.js';

function okResult(keyword: KeywordRecord, config: ResearchConfig): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: {
        volume: 100,
        cpc: 1.25,
        market: config.research.market,
        fetchedAt: '2026-09-01T00:00:00.000Z',
      },
      google: {
        hl: config.research.googleHl,
        gl: config.research.googleGl,
        pageUrl: 'https://google.com/search?q=x',
        detectedLocation: null,
        geoWarning: false,
      },
      error: null,
    },
    serpRows: [],
    related: { status: 'empty', error: null, rows: [] },
    debugArtifactPath: null,
  };
}

test('runDiscovery keeps per-keyword SQLite truth while bounding full running snapshot rewrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'discovery-snapshot-cadence-'));
  const inputPath = join(root, 'seeds.csv');
  const outputRoot = join(root, 'output');
  const seeds = Array.from({ length: 55 }, (_, index) => `keyword ${index + 1}`);
  await writeFile(inputPath, `keyword\n${seeds.join('\n')}\n`, 'utf8');

  const deps: CliDeps = {
    connect: async () => ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, config, record) => okResult(record, config),
  };

  const result = await runDiscovery(
    { input: { kind: 'seeds', path: inputPath }, outputRoot, name: 'snapshot-cadence' },
    deps,
    { CACHE_DB_PATH: join(root, 'cache.sqlite'), EXPANSION_ENABLED: 'false' } as NodeJS.ProcessEnv,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.state, 'completed');
  assert.ok(result.discoveryDirectory);

  const files = await readdir(result.discoveryDirectory);
  const timingName = files.find((name) => name.startsWith('discovery-timing-') && name.endsWith('.json'));
  assert.ok(timingName, 'timing artifact must be published');
  const timing = JSON.parse(await readFile(join(result.discoveryDirectory, timingName), 'utf8')) as {
    counts: { snapshotCallbacks: number; snapshotPublishes: number; snapshotSkips: number };
    snapshotSamples: Array<{ state: string; reason: string; published: boolean }>;
  };

  assert.deepEqual(timing.counts, {
    ...timing.counts,
    snapshotCallbacks: 56,
    snapshotPublishes: 3,
    snapshotSkips: 53,
  });
  assert.equal(timing.snapshotSamples[0]?.reason, 'first');
  assert.equal(timing.snapshotSamples.some((sample) => sample.reason === 'keyword_interval' && sample.published), true);
  assert.deepEqual(timing.snapshotSamples.at(-1), {
    state: 'completed',
    reason: 'terminal',
    published: true,
    durationMs: timing.snapshotSamples.at(-1)?.durationMs,
  });

  const keywordCsv = await readFile(join(result.discoveryDirectory, 'keywords.csv'), 'utf8');
  const nonEmptyLines = keywordCsv.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(nonEmptyLines.length, 56, 'final derived snapshot must contain all 55 durable keywords plus header');
});
