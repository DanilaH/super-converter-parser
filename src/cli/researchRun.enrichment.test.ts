import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import type { CollectionResult } from '../browser/collect.js';
import type { ResearchConfig } from '../config/config.js';
import type { CliDeps } from '../discovery/runDiscovery.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { KeywordRecord } from '../runs/run.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  parseResearchRunArgs,
  runResearchFromConfig,
  runResearchFromExisting,
} from './researchRun.js';

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

function fakeBrowserDeps(): CliDeps {
  return {
    connect: async () => ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, config, keyword) => completed(keyword, config),
  };
}

test('research:run args require one explicit workflow identity and scope continuation to existing research', () => {
  assert.deepEqual(parseResearchRunArgs(['--research', 'research-1', '--continue', 'next.json']).research, 'research-1');
  assert.throws(() => parseResearchRunArgs(['--config', 'a.json', '--research', 'research-1']), /exactly one/);
  assert.throws(() => parseResearchRunArgs(['--config', 'a.json', '--continue', 'next.json']), /only valid with --research/);
});

test('fresh config truthfully stops at awaiting_shortlist instead of inventing enrichment scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-run-await-shortlist-'));
  const outputRoot = join(root, 'output');
  await mkdir(join(root, 'input'), { recursive: true });
  await writeFile(join(root, 'input', 'seeds.csv'), 'keyword\nk1\nk2\nk3\nk4\nk5\n', 'utf8');
  const configPath = join(root, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    research: { label: 'await-shortlist', input: { type: 'seeds', path: 'input/seeds.csv' } },
    workflow: { target: 'enrichment' },
    enrichment: { modules: ['query_suggestions'] },
  }), 'utf8');

  let enrichmentCalls = 0;
  const execution = await runResearchFromConfig(
    configPath,
    outputRoot,
    {
      ...DEFAULT_RESEARCH_RUN_DEPS,
      cliDeps: fakeBrowserDeps(),
      runConfiguredEnrichment: async () => {
        enrichmentCalls += 1;
        throw new Error('must not execute without shortlist');
      },
    },
    { CACHE_DB_PATH: join(root, 'cache.sqlite') } as NodeJS.ProcessEnv,
  );

  assert.equal(execution.exitCode, 0);
  assert.ok(execution.result.researchId);
  assert.equal(execution.result.discoveryState, 'completed');
  assert.equal(execution.result.enrichmentId, null);
  assert.equal(execution.result.workflowState, 'awaiting_shortlist');
  assert.equal(execution.result.stopPoint, 'enrichment');
  assert.deepEqual(execution.result.unresolvedHumanRequirements, ['shortlist']);
  assert.equal(enrichmentCalls, 0);
});

test('stable research continuation resolves current discovery and executes enrichment without a copied run id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-run-existing-enrichment-'));
  const outputRoot = join(root, 'output');
  await mkdir(join(root, 'input'), { recursive: true });
  await writeFile(join(root, 'input', 'seeds.csv'), 'keyword\nk1\nk2\nk3\nk4\nk5\n', 'utf8');
  const configPath = join(root, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    research: { label: 'continue-enrichment', input: { type: 'seeds', path: 'input/seeds.csv' } },
    workflow: { target: 'enrichment' },
    enrichment: {
      modules: ['query_suggestions'],
      querySuggestions: { sources: ['surfer_related'], maxSuggestionsPerSource: 7, maxParents: 25 },
    },
  }), 'utf8');

  const initial = await runResearchFromConfig(
    configPath,
    outputRoot,
    { ...DEFAULT_RESEARCH_RUN_DEPS, cliDeps: fakeBrowserDeps() },
    { CACHE_DB_PATH: join(root, 'cache.sqlite') } as NodeJS.ProcessEnv,
  );
  assert.equal(initial.result.workflowState, 'awaiting_shortlist');
  const researchId = initial.result.researchId;
  assert.ok(researchId);

  const shortlistPath = join(root, 'shortlist.csv');
  await writeFile(shortlistPath, 'keyword\nk1\nk2\nk3\nk4\nk5\n', 'utf8');
  const continuationPath = join(root, 'continuation.json');
  await writeFile(continuationPath, JSON.stringify({
    version: 1,
    researchId,
    action: { type: 'shortlist', path: 'shortlist.csv' },
  }), 'utf8');

  const observed: Array<Parameters<typeof DEFAULT_RESEARCH_RUN_DEPS.runConfiguredEnrichment>[0]> = [];
  const execution = await runResearchFromExisting(
    researchId,
    continuationPath,
    outputRoot,
    {
      ...DEFAULT_RESEARCH_RUN_DEPS,
      runDiscovery: async () => { throw new Error('existing research must not rerun discovery'); },
      runConfiguredEnrichment: async (request) => {
        observed.push(request);
        return {
          outcome: { kind: 'completed', enrichmentId: 'configured-enrichment', state: 'completed', result: {} },
          enrichmentId: 'configured-enrichment',
          enrichmentDirectory: join(request.researchDirectory, 'enrichment'),
          resumed: false,
          archivePath: null,
        };
      },
    },
    {} as NodeJS.ProcessEnv,
  );

  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.researchId, researchId);
  assert.equal(execution.result.discoveryRunId, researchId);
  assert.equal(execution.result.enrichmentId, 'configured-enrichment');
  assert.equal(execution.result.enrichmentState, 'completed');
  assert.equal(execution.result.workflowState, 'completed');
  assert.equal(execution.result.stopPoint, 'complete');
  assert.equal(observed.length, 1);
  const request = observed[0];
  assert.ok(request);
  assert.equal(request.researchId, researchId);
  assert.equal(request.sourceRunId, researchId);
  assert.equal(request.currentEnrichmentId, null);
  assert.equal(request.shortlistPath, shortlistPath);
});

test('stable research resumes the same durable running enrichment generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-run-running-enrichment-'));
  const outputRoot = join(root, 'output');
  await mkdir(join(root, 'input'), { recursive: true });
  await writeFile(join(root, 'input', 'seeds.csv'), 'keyword\nk1\nk2\nk3\nk4\nk5\n', 'utf8');
  const configPath = join(root, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    research: { label: 'running-enrichment-recovery', input: { type: 'seeds', path: 'input/seeds.csv' } },
    workflow: { target: 'enrichment' },
    enrichment: {
      modules: ['query_suggestions'],
      querySuggestions: { sources: ['surfer_related'], maxSuggestionsPerSource: 7, maxParents: 25 },
    },
  }), 'utf8');

  const initial = await runResearchFromConfig(
    configPath,
    outputRoot,
    { ...DEFAULT_RESEARCH_RUN_DEPS, cliDeps: fakeBrowserDeps() },
    { CACHE_DB_PATH: join(root, 'cache.sqlite') } as NodeJS.ProcessEnv,
  );
  assert.equal(initial.result.workflowState, 'awaiting_shortlist');
  const researchId = initial.result.researchId;
  assert.ok(researchId);

  const baseStatus = await DEFAULT_RESEARCH_RUN_DEPS.buildStatus({ outputRoot, targetRunId: researchId });
  const runningEnrichmentId = 'running-enrichment';
  const runningStatus: ResearchStatusWithHistoricalPresence = {
    ...baseStatus,
    enrichments: [{
      enrichmentId: runningEnrichmentId,
      generation: 1,
      directoryName: 'enrichment',
      sourceRunId: baseStatus.discovery.runId,
      state: 'running',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
      modules: ['query_suggestions'],
      itemCounts: {},
      error: null,
      isForCurrentDiscovery: true,
      isLatestForCurrentDiscovery: true,
    }],
    currentEnrichmentId: runningEnrichmentId,
    nextAction: {
      code: 'resume_enrichment',
      message: 'Resume current enrichment.',
      command: `npm run research:run -- --research ${researchId}`,
    },
  };

  const observed: Array<Parameters<typeof DEFAULT_RESEARCH_RUN_DEPS.runConfiguredEnrichment>[0]> = [];
  const execution = await runResearchFromExisting(
    researchId,
    null,
    outputRoot,
    {
      ...DEFAULT_RESEARCH_RUN_DEPS,
      buildStatus: async () => runningStatus,
      acquireExecutionLock: async () => async () => undefined,
      runDiscovery: async () => { throw new Error('running enrichment recovery must not rerun discovery'); },
      runConfiguredEnrichment: async (request) => {
        observed.push(request);
        return {
          outcome: { kind: 'completed', enrichmentId: runningEnrichmentId, state: 'completed', result: {} },
          enrichmentId: runningEnrichmentId,
          enrichmentDirectory: join(request.researchDirectory, 'enrichment'),
          resumed: true,
          archivePath: null,
        };
      },
    },
    {} as NodeJS.ProcessEnv,
  );

  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.enrichmentId, runningEnrichmentId);
  assert.equal(execution.result.enrichmentState, 'completed');
  assert.equal(execution.result.workflowState, 'completed');
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.currentEnrichmentId, runningEnrichmentId);
  assert.equal(observed[0]?.shortlistPath, null);
});
