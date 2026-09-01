import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import type { CollectionResult } from '../browser/collect.js';
import type { ResearchConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import type { CliDeps } from '../discovery/runDiscovery.js';
import type { KeywordRecord } from '../runs/run.js';
import { runCli as runLegacyResearch } from './research.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  runResearchFromConfig,
  runResearchRunCli,
} from './researchRun.js';

function okResult(keyword: KeywordRecord, config: ResearchConfig): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: { volume: 100, cpc: 1.25, market: config.research.market, fetchedAt: '2026-09-01T00:00:00.000Z' },
      google: { hl: config.research.googleHl, gl: config.research.googleGl, pageUrl: 'https://google.com/search?q=x', detectedLocation: null, geoWarning: false },
      error: null,
    },
    serpRows: [],
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  };
}

async function onlyRunIndex(outputRoot: string): Promise<{ runId: string; researchDirectory: string; discoveryDirectory: string }> {
  const names = (await readdir(join(outputRoot, 'index', 'runs'))).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, 1);
  return JSON.parse(await readFile(join(outputRoot, 'index', 'runs', names[0] as string), 'utf8')) as {
    runId: string;
    researchDirectory: string;
    discoveryDirectory: string;
  };
}

function semanticSnapshot(config: ResearchConfig) {
  return {
    research: config.research,
    expansion: config.expansion,
    requireAhrefs: config.ahrefs.requireAhrefs,
    scoring: config.scoring,
  };
}

test('research:run executes resolved semantics, publishes provenance before provider work, and returns stable machine identity', async () => {
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
  const order: string[] = [];
  const cliDeps: CliDeps = {
    connect: async () => {
      order.push('connect');
      return ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, config, record) => {
      observedConfigs.push(config);
      return okResult(record, config);
    },
  };
  const deps = {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    cliDeps,
    writeProvenance: async (...args: Parameters<typeof DEFAULT_RESEARCH_RUN_DEPS.writeProvenance>) => {
      order.push('provenance');
      return DEFAULT_RESEARCH_RUN_DEPS.writeProvenance(...args);
    },
    runConfiguredEnrichment: async (...args: Parameters<typeof DEFAULT_RESEARCH_RUN_DEPS.runConfiguredEnrichment>) => ({
      outcome: { kind: 'completed' as const, enrichmentId: 'test-enrichment', state: 'completed' as const, result: {} },
      enrichmentId: 'test-enrichment',
      enrichmentDirectory: join(args[0].researchDirectory, 'test-enrichment'),
      resumed: false,
      archivePath: null,
    }),
  };

  const execution = await runResearchFromConfig(
    configPath,
    outputRoot,
    deps,
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
      SCORING_DR_VERY_WEAK_MAX: '1',
      SCORING_DR_WEAK_MAX: '2',
      SCORING_DR_STRONG_MIN: '98',
      SCORING_DR_STRONG_MAX: '99',
    } as NodeJS.ProcessEnv,
  );

  assert.equal(execution.exitCode, 0);
  assert.equal(observedConfigs.length, 1);
  assert.ok(order.indexOf('provenance') >= 0);
  assert.ok(order.indexOf('connect') > order.indexOf('provenance'));
  const observed = observedConfigs[0] as ResearchConfig;
  assert.deepEqual(observed.research, { market: 'GB', googleHl: 'en', googleGl: 'gb', topN: 7 });
  assert.deepEqual(observed.expansion, { enabled: true, depth: 1, maxCandidatesPerKeyword: 20, minOverlap: 0, minVolume: 0 });
  assert.equal(observed.ahrefs.requireAhrefs, false);
  assert.deepEqual(observed.scoring.drThresholds, { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 });

  const indexRecord = await onlyRunIndex(outputRoot);
  assert.equal(execution.result.researchId, indexRecord.runId);
  assert.equal(execution.result.discoveryRunId, indexRecord.runId);
  assert.equal(execution.result.discoveryState, 'completed');
  assert.equal(execution.result.workflowTarget, 'enrichment');
  assert.equal(execution.result.enrichmentId, 'test-enrichment');
  assert.equal(execution.result.enrichmentState, 'completed');
  assert.equal(execution.result.workflowState, 'completed');
  assert.equal(execution.result.stopPoint, 'complete');
  assert.equal(execution.result.operatorConfigPath, join(indexRecord.researchDirectory, 'operator-config.json'));

  const store = RunStore.openReadOnly(join(indexRecord.discoveryDirectory, 'run.sqlite'));
  try {
    const run = store.loadRun(indexRecord.runId);
    assert.ok(run);
    assert.deepEqual(semanticSnapshot(run.configSnapshot), semanticSnapshot(observed));
  } finally {
    store.close();
  }

  const provenanceText = await readFile(join(indexRecord.researchDirectory, 'operator-config.json'), 'utf8');
  const provenance = JSON.parse(provenanceText) as {
    authoredConfig: { research: { input: { path: string } } };
    semantics: { research: { input: Record<string, unknown> }; workflow: { target: string }; discovery: { scoringPolicy: Record<string, number> } };
  };
  assert.equal(provenance.authoredConfig.research.input.path, 'input/seeds.csv');
  assert.deepEqual(provenance.semantics.research.input, { type: 'seeds', logicalPath: 'input/seeds.csv' });
  assert.equal(provenance.semantics.workflow.target, 'enrichment');
  assert.deepEqual(provenance.semantics.discovery.scoringPolicy, { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 });
  assert.equal(provenanceText.includes(root), false);

  const archive = await readFile(join(indexRecord.researchDirectory, 'results.zip'));
  assert.equal(archive.includes(Buffer.from('operator-config.json')), true);
  assert.equal((await readdir(indexRecord.researchDirectory)).some((entry) => entry.startsWith('enrichment')), false);
});

test('config-first and legacy discovery share equivalent persisted semantic core inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-run-parity-'));
  const inputPath = join(root, 'seeds.csv');
  await writeFile(inputPath, 'keyword\njson diff\n', 'utf8');
  const configPath = join(root, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    research: { label: 'parity', input: { type: 'seeds', path: 'seeds.csv' } },
    discovery: { topN: 10, expand: true, requireAhrefs: false },
  }), 'utf8');

  const cliDeps: CliDeps = {
    connect: async () => ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, config, record) => okResult(record, config),
  };
  const legacyOutput = join(root, 'legacy-output');
  const configOutput = join(root, 'config-output');
  const legacyCode = await runLegacyResearch(
    ['--seeds', inputPath, '--name', 'parity', '--expand', '--output-root', legacyOutput],
    cliDeps,
    { CACHE_DB_PATH: join(root, 'legacy-cache.sqlite') } as NodeJS.ProcessEnv,
  );
  assert.equal(legacyCode, 0);
  const configExecution = await runResearchFromConfig(
    configPath,
    configOutput,
    { ...DEFAULT_RESEARCH_RUN_DEPS, cliDeps },
    { CACHE_DB_PATH: join(root, 'config-cache.sqlite') } as NodeJS.ProcessEnv,
  );
  assert.equal(configExecution.exitCode, 0);

  const legacyIndex = await onlyRunIndex(legacyOutput);
  const configIndex = await onlyRunIndex(configOutput);
  const legacyStore = RunStore.openReadOnly(join(legacyIndex.discoveryDirectory, 'run.sqlite'));
  const configStore = RunStore.openReadOnly(join(configIndex.discoveryDirectory, 'run.sqlite'));
  try {
    const legacyRun = legacyStore.loadRun(legacyIndex.runId);
    const configRun = configStore.loadRun(configIndex.runId);
    assert.ok(legacyRun);
    assert.ok(configRun);
    assert.deepEqual(semanticSnapshot(configRun.configSnapshot), semanticSnapshot(legacyRun.configSnapshot));
  } finally {
    legacyStore.close();
    configStore.close();
  }
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
