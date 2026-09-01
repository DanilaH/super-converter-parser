import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import type { ResearchConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import type { CollectionResult } from '../browser/collect.js';
import type { KeywordRecord } from '../runs/run.js';
import type { CliDeps } from './research.js';
import { DEFAULT_RESEARCH_RUN_DEPS, runResearchRunCli } from './researchRun.js';

function okResult(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: { volume: 100, cpc: 1.25, market: 'GB', fetchedAt: '2026-09-01T00:00:00.000Z' },
      google: { hl: 'en', gl: 'gb', pageUrl: 'https://google.com/search?q=x', detectedLocation: null, geoWarning: false },
      error: null,
    },
    serpRows: [],
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  };
}

test('research:run executes discovery with config semantics instead of conflicting semantic env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-run-config-'));
  const configDir = join(root, 'config');
  const outputRoot = join(root, 'output');
  await mkdir(join(configDir, 'input'), { recursive: true });
  await writeFile(join(configDir, 'input', 'seeds.csv'), 'keyword\njson diff\n', 'utf8');
  const configPath = join(configDir, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    research: {
      label: 'config-first-parity',
      market: 'GB',
      googleHl: 'en',
      googleGl: 'gb',
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
    workflow: { target: 'enrichment' },
    discovery: { topN: 7, expand: true, requireAhrefs: false },
    enrichment: { modules: ['clusters'] },
  }), 'utf8');

  const observedConfigs: ResearchConfig[] = [];
  const cliDeps: CliDeps = {
    connect: async () => ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, config, record) => {
      observedConfigs.push(config);
      return okResult(record);
    },
  };

  const code = await runResearchRunCli(
    ['--config', configPath, '--output-root', outputRoot],
    { ...DEFAULT_RESEARCH_RUN_DEPS, cliDeps },
    {
      CACHE_DB_PATH: join(root, 'cache', 'cache.sqlite'),
      RESEARCH_MARKET: 'DE',
      GOOGLE_HL: 'de',
      GOOGLE_GL: 'de',
      TOP_N: '3',
      EXPANSION_ENABLED: 'false',
      EXPANSION_DEPTH: '1',
      EXPANSION_MAX_CANDIDATES: '99',
      EXPANSION_MIN_OVERLAP: '55',
      EXPANSION_MIN_VOLUME: '999',
      REQUIRE_AHREFS: 'true',
    } as NodeJS.ProcessEnv,
  );
  assert.equal(code, 0);
  assert.equal(observedConfigs.length, 1);
  const observed = observedConfigs[0] as ResearchConfig;
  assert.deepEqual(observed.research, { market: 'GB', googleHl: 'en', googleGl: 'gb', topN: 7 });
  assert.deepEqual(observed.expansion, {
    enabled: true,
    depth: 1,
    maxCandidatesPerKeyword: 20,
    minOverlap: 0,
    minVolume: 0,
  });
  assert.equal(observed.ahrefs.requireAhrefs, false);

  const runIndexNames = (await readdir(join(outputRoot, 'index', 'runs'))).filter((name) => name.endsWith('.json'));
  assert.equal(runIndexNames.length, 1);
  const indexRecord = JSON.parse(await readFile(join(outputRoot, 'index', 'runs', runIndexNames[0] as string), 'utf8')) as {
    runId: string;
    researchDirectory: string;
    discoveryDirectory: string;
  };
  const store = RunStore.openReadOnly(join(indexRecord.discoveryDirectory, 'run.sqlite'));
  try {
    const run = store.loadRun(indexRecord.runId);
    assert.ok(run);
    assert.deepEqual(run.configSnapshot.research, observed.research);
    assert.deepEqual(run.configSnapshot.expansion, observed.expansion);
    assert.equal(run.configSnapshot.ahrefs.requireAhrefs, false);
  } finally {
    store.close();
  }

  const provenanceText = await readFile(join(indexRecord.researchDirectory, 'operator-config.json'), 'utf8');
  const provenance = JSON.parse(provenanceText) as {
    authoredConfig: { research: { input: { path: string } } };
    semantics: { research: { input: Record<string, unknown> }; workflow: { target: string } };
  };
  assert.equal(provenance.authoredConfig.research.input.path, 'input/seeds.csv');
  assert.deepEqual(provenance.semantics.research.input, { type: 'seeds', logicalPath: 'input/seeds.csv' });
  assert.equal(provenance.semantics.workflow.target, 'enrichment');
  assert.equal(provenanceText.includes(root), false);

  const archive = await readFile(join(indexRecord.researchDirectory, 'results.zip'));
  assert.equal(archive.includes(Buffer.from('operator-config.json')), true);
  assert.equal((await readdir(indexRecord.researchDirectory)).some((entry) => entry.startsWith('enrichment')), false);
});

test('research:run rejects missing config before durable research allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-run-invalid-'));
  const outputRoot = join(root, 'output');
  const code = await runResearchRunCli(
    ['--config', join(root, 'missing.json'), '--output-root', outputRoot],
    DEFAULT_RESEARCH_RUN_DEPS,
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(code, 2);
  await assert.rejects(readdir(outputRoot));
});
