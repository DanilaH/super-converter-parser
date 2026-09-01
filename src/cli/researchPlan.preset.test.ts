import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { OperatorResearchConfigSourceV1 } from '../operatorConfig/contracts.js';
import { loadBuiltInOperatorPreset, mergeOperatorResearchConfig } from '../operatorConfig/presets.js';
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan, type LoadedOperatorResearchConfig } from '../operatorConfig/resolve.js';
import { runResearchPlanCli, type ResearchPlanDeps } from './researchPlan.js';

async function loadedPreset(): Promise<LoadedOperatorResearchConfig> {
  const sourceConfig: OperatorResearchConfigSourceV1 = {
    version: 1,
    preset: 'standard',
    research: { label: 'preset-plan', input: { type: 'seeds', path: 'seeds.csv' } },
    discovery: { expand: false },
  };
  const preset = await loadBuiltInOperatorPreset('standard');
  const config = mergeOperatorResearchConfig(sourceConfig, preset);
  return {
    config,
    sourceConfig,
    preset,
    plan: buildNewResearchPlan(config, '/tmp/research.config.json', { sourceConfig, preset }),
  };
}

function existingStatus(): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'preset-plan',
    researchDirectory: '/tmp/research',
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'run-1',
      state: 'completed',
      createdAt: 'x',
      updatedAt: 'x',
      pauseReason: null,
      keywordCounts: { total: 1, pending: 0, running: 0, completed: 1, partial: 0, failed: 0, repairable: 0 },
      qualityWarnings: [],
    },
    enrichments: [],
    currentEnrichmentId: null,
    finalization: {
      state: 'not_started',
      enrichmentId: null,
      finalistCount: 0,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: null,
    },
    library: { published: false, publicationId: null, publishedAt: null, reason: 'none', lookupError: null },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: { code: 'run_enrichment', message: 'Run enrichment.', command: null },
  };
}

test('new research text plan shows preset revision and value origins', async () => {
  const loaded = await loadedPreset();
  const deps: ResearchPlanDeps = {
    loadConfig: async () => loaded,
    loadContinuation: async () => { throw new Error('unexpected'); },
    loadProvenance: async () => { throw new Error('unexpected'); },
    buildStatus: async () => { throw new Error('unexpected'); },
  };

  const result = await runResearchPlanCli(['--config', 'research.config.json'], deps, {});
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Preset provenance/);
  assert.match(result.stdout, /Preset: standard@1/);
  assert.match(result.stdout, /preset: .*\$\.workflow\.target/);
  assert.match(result.stdout, /file: .*\$\.discovery\.expand/);
  assert.match(result.stdout, /file: .*\$\.research\.label/);
});

test('existing research text plan keeps preset identity from immutable provenance', async () => {
  const loaded = await loadedPreset();
  const persisted = buildPersistedOperatorConfig(loaded);
  const deps: ResearchPlanDeps = {
    loadConfig: async () => { throw new Error('unexpected'); },
    loadContinuation: async () => { throw new Error('unexpected'); },
    loadProvenance: async () => persisted,
    buildStatus: async () => existingStatus(),
  };

  const result = await runResearchPlanCli(
    ['--research', 'research-1'],
    deps,
    { RESEARCH_OUTPUT_ROOT: '/tmp/out' },
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Preset: standard@1/);
  assert.match(result.stdout, /preset: .*\$\.enrichment\.modules/);
});
