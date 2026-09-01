import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import type { CollectionResult } from '../browser/collect.js';
import type { ResearchConfig } from '../config/config.js';
import type { CliDeps } from '../discovery/runDiscovery.js';
import type { KeywordRecord } from '../runs/run.js';
import { DEFAULT_RESEARCH_RUN_DEPS, runResearchFromConfig } from './researchRun.js';

function completed(record: KeywordRecord, config: ResearchConfig): CollectionResult {
  return {
    record: {
      ...record,
      status: 'completed',
      surfer: {
        volume: 100,
        cpc: 1,
        market: config.research.market,
        fetchedAt: new Date().toISOString(),
      },
      google: {
        hl: config.research.googleHl,
        gl: config.research.googleGl,
        pageUrl: `https://google.com/search?q=${encodeURIComponent(record.keyword)}`,
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

test('fresh config-first researches reuse compatible cache without reusing durable research identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'config-first-cache-acceptance-'));
  const configDirectory = join(root, 'config');
  const outputRoot = join(root, 'output');
  const cachePath = join(root, 'cache', 'cache.sqlite');
  await mkdir(join(configDirectory, 'input'), { recursive: true });
  await writeFile(join(configDirectory, 'input', 'seeds.csv'), 'keyword\njson formatter\n', 'utf8');
  const configPath = join(configDirectory, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    preset: 'quick-scan',
    research: {
      label: 'cache-acceptance',
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
  }), 'utf8');

  let connectCalls = 0;
  let preflightCalls = 0;
  let collectCalls = 0;
  const cliDeps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser;
    },
    preflight: async () => {
      preflightCalls += 1;
    },
    collect: async (_context, config, record) => {
      collectCalls += 1;
      return completed(record, config);
    },
  };
  const deps = { ...DEFAULT_RESEARCH_RUN_DEPS, cliDeps };
  const env = { CACHE_DB_PATH: cachePath } as NodeJS.ProcessEnv;

  const first = await runResearchFromConfig(configPath, outputRoot, deps, env);
  assert.equal(first.exitCode, 0);
  assert.equal(first.result.discoveryState, 'completed');
  assert.equal(first.result.workflowState, 'completed');
  assert.equal(connectCalls, 1);
  assert.equal(preflightCalls, 1);
  assert.equal(collectCalls, 1);

  const second = await runResearchFromConfig(configPath, outputRoot, deps, env);
  assert.equal(second.exitCode, 0);
  assert.equal(second.result.discoveryState, 'completed');
  assert.equal(second.result.workflowState, 'completed');
  assert.notEqual(second.result.researchId, first.result.researchId);
  assert.equal(second.result.effectiveConfigFingerprint, first.result.effectiveConfigFingerprint);
  assert.deepEqual(second.result.stageFingerprints, first.result.stageFingerprints);

  assert.equal(connectCalls, 1, 'cache-only second research must not reconnect Research Chrome');
  assert.equal(preflightCalls, 1, 'cache-only second research must not rerun browser preflight');
  assert.equal(collectCalls, 1, 'cache-only second research must not recollect the keyword');
});
