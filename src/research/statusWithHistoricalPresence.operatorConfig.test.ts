import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { buildNewResearchPlan, type LoadedOperatorResearchConfig } from '../operatorConfig/resolve.js';
import { writeOperatorConfigProvenance } from '../operatorConfig/provenance.js';
import { allocateResearchLocation, writeRunIndex } from '../outputs/researchLayout.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { buildResearchStatusWithHistoricalPresence } from './statusWithHistoricalPresence.js';

const CONFIG = loadConfig({});

async function createConfiguredResearch(input: {
  target: 'discovery' | 'enrichment';
  state: 'paused' | 'completed';
}): Promise<{ outputRoot: string; runId: string }> {
  const outputRoot = await mkdtemp(join(tmpdir(), 'config-status-'));
  const location = await allocateResearchLocation(outputRoot, `status-${input.target}`);
  const runId = `run_${input.target}_${input.state}`;
  const seeds = buildSeedKeywords([{ keyword: 'json formatter', rowNumber: 1 }]);
  const store = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
  store.createRun({
    runId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: seeds,
  });
  if (input.state === 'completed') {
    const keyword = store.loadKeywords(runId)[0]!;
    store.commitKeyword(runId, {
      ...keyword,
      status: 'completed',
      surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-09-02T00:00:00.000Z' },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=json+formatter',
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'empty',
        serpError: null,
      },
      error: null,
      collectedAt: '2026-09-02T00:00:00.000Z',
    }, [], 'miss');
    store.setRunState(runId, 'completed');
  } else {
    store.setRunState(runId, 'paused', { pauseReason: 'fixture interruption' });
  }
  store.close();
  await writeRunIndex(outputRoot, {
    version: 1,
    runId,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });

  const config = {
    version: 1 as const,
    research: { label: `status-${input.target}`, input: { type: 'seeds' as const, path: 'input/seeds.csv' } },
    workflow: { target: input.target },
    ...(input.target === 'enrichment' ? { enrichment: { modules: ['clusters' as const] } } : {}),
  };
  const loaded = {
    config,
    plan: buildNewResearchPlan(config, join(location.researchDirectory, 'research.config.json')),
  } as LoadedOperatorResearchConfig;
  await writeOperatorConfigProvenance(location.researchDirectory, loaded);
  return { outputRoot, runId };
}

test('completed discovery-only config is complete instead of suggesting legacy enrichment', async () => {
  const fixture = await createConfiguredResearch({ target: 'discovery', state: 'completed' });
  const status = await buildResearchStatusWithHistoricalPresence({
    outputRoot: fixture.outputRoot,
    targetRunId: fixture.runId,
  });
  assert.equal(status.nextAction.code, 'none');
  assert.equal(status.nextAction.command, null);
  assert.match(status.nextAction.message, /requested by the persisted OperatorConfig are complete/i);
});

test('completed discovery with enrichment target points back to stable config-first execution', async () => {
  const fixture = await createConfiguredResearch({ target: 'enrichment', state: 'completed' });
  const status = await buildResearchStatusWithHistoricalPresence({
    outputRoot: fixture.outputRoot,
    targetRunId: fixture.runId,
  });
  assert.equal(status.nextAction.code, 'run_enrichment');
  assert.equal(status.nextAction.command, `npm run research:run -- --research ${fixture.runId}`);
  assert.doesNotMatch(status.nextAction.message, /enrich:full/i);
});

test('paused config-first discovery points to stable config-first resume instead of legacy generated-id resume', async () => {
  const fixture = await createConfiguredResearch({ target: 'enrichment', state: 'paused' });
  const status = await buildResearchStatusWithHistoricalPresence({
    outputRoot: fixture.outputRoot,
    targetRunId: fixture.runId,
  });
  assert.equal(status.nextAction.code, 'resume_discovery');
  assert.equal(status.nextAction.command, `npm run research:run -- --research ${fixture.runId}`);
  assert.doesNotMatch(status.nextAction.command ?? '', /npm run research -- --resume/);
});
