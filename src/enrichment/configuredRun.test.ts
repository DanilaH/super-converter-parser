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
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan } from '../operatorConfig/resolve.js';
import type { OperatorResearchConfigV1 } from '../operatorConfig/contracts.js';
import type { KeywordRecord } from '../runs/run.js';
import { DEFAULT_RESEARCH_RUN_DEPS, runResearchFromConfig } from '../cli/researchRun.js';
import {
  CONFIGURED_ENRICHMENT_HTTP_DEFAULTS,
  CONFIGURED_ENRICHMENT_PAGES_DEFAULTS,
  CONFIGURED_ENRICHMENT_SITE_STRUCTURE_DEFAULTS,
  buildConfiguredModuleConfig,
} from './configuredRun.js';
import { CLUSTERING_ALGORITHM_VERSION } from './clustering.js';
import { CLUSTER_URL_IDENTITY_VERSION } from './urlIdentity.js';
import { QUERY_SUGGESTION_PARSER_VERSION } from './types.js';

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

function persisted(config: OperatorResearchConfigV1) {
  return buildPersistedOperatorConfig({ config, plan: buildNewResearchPlan(config, '/tmp/research.config.json') });
}

test('configured enrichment maps only persisted semantic policy into engine config', () => {
  const operator = persisted({
    version: 1,
    research: { label: 'semantic-map', input: { type: 'seeds', path: 'input.csv' } },
    workflow: { target: 'enrichment' },
    enrichment: {
      modules: ['query_suggestions', 'clusters'],
      clustering: { topN: 7, minSharedDomains: 2, minDomainJaccard: 0.4, minSharedUrls: 1, minUrlJaccard: 0.2 },
      querySuggestions: { sources: ['surfer_related'], maxSuggestionsPerSource: 9, maxParents: 25 },
    },
  });
  const config = buildConfiguredModuleConfig(operator);
  assert.deepEqual(config.clusters, {
    topN: 7,
    edgeRule: { minSharedDomains: 2, minJaccard: 0.4, minSharedUrls: 1, minUrlJaccard: 0.2 },
    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
    urlIdentityVersion: CLUSTER_URL_IDENTITY_VERSION,
    groupingRule: 'complete_link',
  });
  assert.deepEqual(config.query_suggestions, {
    sources: ['surfer_related'],
    maxSuggestionsPerSource: 9,
    maxParents: 25,
    rateLimitMinDelayMs: 1000,
    rateLimitMaxDelayMs: 10_000,
    algorithmVersion: QUERY_SUGGESTION_PARSER_VERSION,
  });
  assert.equal('shortlist' in config, false);
});

test('configured operational defaults retain the accepted legacy enrichment bounds', () => {
  assert.deepEqual(CONFIGURED_ENRICHMENT_HTTP_DEFAULTS, {
    enabled: true,
    maxRedirects: 5,
    timeoutMs: 15_000,
    maxBytes: 2_000_000,
    maxTextBytes: 500_000,
    userAgent: 'UtilityResearchRunner/1.0 (+https://local.dev)',
    respectRetryAfter: true,
    minDelayMs: 500,
    maxDelayMs: 2000,
    maxRetries: 2,
    baseRetryDelayMs: 1000,
  });
  assert.deepEqual(CONFIGURED_ENRICHMENT_PAGES_DEFAULTS, {
    enabled: true,
    topUrlsPerKeyword: 3,
    includeMainText: false,
    mainTextMaxChars: 5000,
  });
  assert.deepEqual(CONFIGURED_ENRICHMENT_SITE_STRUCTURE_DEFAULTS, {
    enabled: true,
    maxSitemapFiles: 10,
    maxUrlsPerSitemap: 100,
    maxSampleUrls: 50,
    maxDomains: 30,
  });
});

test('fresh config-first clusters execution creates durable enrichment pinned to current discovery without manual ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'configured-enrichment-clusters-'));
  const outputRoot = join(root, 'output');
  await mkdir(join(root, 'input'), { recursive: true });
  await writeFile(join(root, 'input', 'seeds.csv'), 'keyword\njson diff\nlist diff\n', 'utf8');
  const configPath = join(root, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    research: { label: 'configured-clusters', input: { type: 'seeds', path: 'input/seeds.csv' } },
    workflow: { target: 'enrichment' },
    enrichment: { modules: ['clusters'] },
  }), 'utf8');

  const execution = await runResearchFromConfig(
    configPath,
    outputRoot,
    { ...DEFAULT_RESEARCH_RUN_DEPS, cliDeps: browserDeps() },
    { CACHE_DB_PATH: join(root, 'cache.sqlite') } as NodeJS.ProcessEnv,
  );
  assert.equal(execution.exitCode, 0);
  assert.ok(execution.result.researchId);
  assert.ok(execution.result.enrichmentId);
  assert.equal(execution.result.enrichmentState, 'completed');
  assert.equal(execution.result.workflowState, 'completed');
  assert.equal(execution.result.stopPoint, 'complete');

  const indexNames = (await readdir(join(outputRoot, 'index', 'enrichments'))).filter((name) => name.endsWith('.json'));
  assert.equal(indexNames.length, 1);
  const index = JSON.parse(await readFile(join(outputRoot, 'index', 'enrichments', indexNames[0] as string), 'utf8')) as {
    enrichmentId: string;
    runId: string;
    enrichmentDirectory: string;
  };
  assert.equal(index.enrichmentId, execution.result.enrichmentId);
  assert.equal(index.runId, execution.result.discoveryRunId);

  const store = RunStore.openReadOnly(join(index.enrichmentDirectory, 'enrichment.sqlite'));
  try {
    const run = store.loadEnrichmentRun(index.enrichmentId);
    assert.ok(run);
    assert.equal(run.sourceRunId, execution.result.discoveryRunId);
    assert.deepEqual(run.modules, ['clusters']);
    assert.equal(run.state, 'completed');
  } finally {
    store.close();
  }
});
