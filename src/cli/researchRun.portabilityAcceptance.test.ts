import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import type { CollectionResult } from '../browser/collect.js';
import type { ResearchConfig } from '../config/config.js';
import type { CliDeps } from '../discovery/runDiscovery.js';
import { loadOperatorResearchConfig } from '../operatorConfig/resolve.js';
import type { KeywordRecord } from '../runs/run.js';
import { DEFAULT_RESEARCH_RUN_DEPS, runResearchFromConfig } from './researchRun.js';

const SECRET_SENTINEL = 'CONFIG_FIRST_SECRET_SENTINEL_zz9Z';

function completed(record: KeywordRecord, config: ResearchConfig): CollectionResult {
  return {
    record: {
      ...record,
      status: 'completed',
      surfer: { volume: 100, cpc: 1, market: config.research.market, fetchedAt: new Date().toISOString() },
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

async function writePortableConfig(root: string): Promise<string> {
  const configDirectory = join(root, 'config');
  await mkdir(join(configDirectory, 'input'), { recursive: true });
  await writeFile(join(configDirectory, 'input', 'seeds.csv'), 'keyword\njson formatter\n', 'utf8');
  const configPath = join(configDirectory, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    preset: 'quick-scan',
    research: {
      label: 'portable-acceptance',
      market: 'US',
      googleHl: 'en',
      googleGl: 'us',
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
  }), 'utf8');
  return configPath;
}

test('config-first semantic fingerprints are machine-independent and immutable provenance excludes secrets and machine paths', async () => {
  const machineA = await mkdtemp(join(tmpdir(), 'config-first-machine-a-'));
  const machineB = await mkdtemp(join(tmpdir(), 'config-first-machine-b-'));
  const configA = await writePortableConfig(machineA);
  const configB = await writePortableConfig(machineB);

  const planA = (await loadOperatorResearchConfig(configA)).plan;
  const planB = (await loadOperatorResearchConfig(configB)).plan;
  assert.equal(planA.effectiveConfigFingerprint, planB.effectiveConfigFingerprint);
  assert.deepEqual(planA.stageFingerprints, planB.stageFingerprints);
  assert.notEqual(planA.semantics.research.input.resolvedPath, planB.semantics.research.input.resolvedPath);

  const cliDeps: CliDeps = {
    connect: async () => ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, config, record) => completed(record, config),
  };
  const deps = { ...DEFAULT_RESEARCH_RUN_DEPS, cliDeps };

  const envA = {
    CACHE_DB_PATH: join(machineA, 'runtime', 'cache.sqlite'),
    RESEARCH_CDP_URL: 'http://127.0.0.1:19999',
    SURFER_WAIT_MS: '12345',
    AHREFS_API_KEY: SECRET_SENTINEL,
    AHREFS_ENDPOINT: 'http://127.0.0.1:9',
  } as NodeJS.ProcessEnv;
  const envB = {
    CACHE_DB_PATH: join(machineB, 'different-runtime', 'cache.sqlite'),
    RESEARCH_CDP_URL: 'http://127.0.0.1:29999',
    SURFER_WAIT_MS: '54321',
  } as NodeJS.ProcessEnv;

  const first = await runResearchFromConfig(configA, join(machineA, 'output'), deps, envA);
  const second = await runResearchFromConfig(configB, join(machineB, 'output'), deps, envB);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(first.result.effectiveConfigFingerprint, second.result.effectiveConfigFingerprint);
  assert.deepEqual(first.result.stageFingerprints, second.result.stageFingerprints);

  const operatorConfigPath = first.result.operatorConfigPath;
  assert.ok(operatorConfigPath);
  const persisted = await readFile(operatorConfigPath, 'utf8');
  assert.equal(persisted.includes(SECRET_SENTINEL), false);
  assert.equal(persisted.includes(machineA), false);
  assert.equal(persisted.includes(envA.CACHE_DB_PATH as string), false);
  assert.equal(persisted.includes(envA.RESEARCH_CDP_URL as string), false);
  assert.equal(persisted.includes('12345'), false);

  const persistedDirectory = dirname(operatorConfigPath);
  assert.ok(persistedDirectory.startsWith(join(machineA, 'output')));
});
