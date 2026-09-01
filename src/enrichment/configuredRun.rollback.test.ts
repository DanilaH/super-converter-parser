import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import type { CollectionResult } from '../browser/collect.js';
import { DEFAULT_RESEARCH_RUN_DEPS, runResearchFromConfig } from '../cli/researchRun.js';
import type { ResearchConfig } from '../config/config.js';
import type { CliDeps } from '../discovery/runDiscovery.js';
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan } from '../operatorConfig/resolve.js';
import { buildResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { KeywordRecord } from '../runs/run.js';
import { ResearchError } from '../shared/errors.js';
import { runConfiguredEnrichment } from './configuredRun.js';

function completed(keyword: KeywordRecord, config: ResearchConfig): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: { volume: 100, cpc: 1, market: config.research.market, fetchedAt: '2026-09-01T00:00:00.000Z' },
      google: { hl: config.research.googleHl, gl: config.research.googleGl, pageUrl: 'https://google.com/search?q=x', detectedLocation: null, geoWarning: false },
      error: null,
    },
    serpRows: [],
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  };
}

function browserDeps(): CliDeps {
  return {
    connect: async () => ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, config, keyword) => completed(keyword, config),
  };
}

test('fresh pre-durable enrichment failure removes its index and directory so research status stays usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'configured-enrichment-rollback-'));
  const outputRoot = join(root, 'output');
  await mkdir(join(root, 'input'), { recursive: true });
  await writeFile(join(root, 'input', 'seeds.csv'), 'keyword\nk1\nk2\nk3\nk4\nk5\n', 'utf8');
  const discoveryConfigPath = join(root, 'discovery.config.json');
  await writeFile(discoveryConfigPath, JSON.stringify({
    version: 1,
    research: { label: 'rollback', input: { type: 'seeds', path: 'input/seeds.csv' } },
    workflow: { target: 'discovery' },
  }), 'utf8');

  const discovery = await runResearchFromConfig(
    discoveryConfigPath,
    outputRoot,
    { ...DEFAULT_RESEARCH_RUN_DEPS, cliDeps: browserDeps() },
    { CACHE_DB_PATH: join(root, 'discovery-cache.sqlite') } as NodeJS.ProcessEnv,
  );
  assert.equal(discovery.exitCode, 0);
  assert.ok(discovery.result.discoveryRunId);
  assert.ok(discovery.result.operatorConfigPath);
  const researchDirectory = dirname(discovery.result.operatorConfigPath);

  const shortlistPath = join(root, 'shortlist.csv');
  await writeFile(shortlistPath, 'keyword\nk1\nk2\nk3\nk4\nk5\n', 'utf8');
  const badCacheParent = join(root, 'cache-parent-is-a-file');
  await writeFile(badCacheParent, 'not a directory', 'utf8');

  const operatorConfig = {
    version: 1 as const,
    research: { label: 'rollback', input: { type: 'seeds' as const, path: 'input/seeds.csv' } },
    workflow: { target: 'enrichment' as const },
    enrichment: { modules: ['domain_age' as const] },
  };
  const persisted = buildPersistedOperatorConfig({
    config: operatorConfig,
    plan: buildNewResearchPlan(operatorConfig, join(root, 'enrichment.config.json')),
  });

  await assert.rejects(
    runConfiguredEnrichment({
      outputRoot,
      researchId: discovery.result.discoveryRunId,
      researchDirectory,
      sourceRunId: discovery.result.discoveryRunId,
      currentEnrichmentId: null,
      operatorConfig: persisted,
      shortlistPath,
      env: { CACHE_DB_PATH: join(badCacheParent, 'cache.sqlite') } as NodeJS.ProcessEnv,
      signal: { cancelled: false },
      logger: () => undefined,
    }),
    (error: unknown) => error instanceof ResearchError && error.code === 'CACHE_DB_ERROR',
  );

  const researchEntries = await readdir(researchDirectory);
  assert.equal(researchEntries.some((name) => /^enrichment(?:-\d+)?$/.test(name)), false);
  const enrichmentIndexEntries = await readdir(join(outputRoot, 'index', 'enrichments'));
  assert.deepEqual(enrichmentIndexEntries, []);

  const status = await buildResearchStatusWithHistoricalPresence({
    outputRoot,
    targetRunId: discovery.result.discoveryRunId,
  });
  assert.equal(status.currentEnrichmentId, null);
  assert.deepEqual(status.enrichments, []);
});
