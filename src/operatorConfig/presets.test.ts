import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { OperatorResearchConfigSourceV1, OperatorResearchConfigV1, OperatorResearchPresetV1 } from './contracts.js';
import {
  buildSemanticOriginHints,
  loadBuiltInOperatorPreset,
  mergeOperatorResearchConfig,
} from './presets.js';
import { buildNewResearchPlan, loadOperatorResearchConfig } from './resolve.js';

function source(preset: string, overrides: Partial<OperatorResearchConfigSourceV1> = {}): OperatorResearchConfigSourceV1 {
  return {
    version: 1,
    preset,
    research: { label: 'preset-test', input: { type: 'seeds', path: 'input/seeds.csv' } },
    ...overrides,
  };
}

test('built-in presets have stable matching id/revision metadata', async () => {
  for (const id of ['quick-scan', 'standard', 'deep-research', 'finalist-validation']) {
    const preset = await loadBuiltInOperatorPreset(id);
    assert.equal(preset.id, id);
    assert.equal(preset.revision, 1);
  }
});

test('standard preset supplies inherited workflow, discovery, and enrichment semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-preset-standard-'));
  const configDir = join(root, 'config');
  await mkdir(join(configDir, 'input'), { recursive: true });
  const configPath = join(configDir, 'research.config.json');
  await writeFile(configPath, JSON.stringify(source('standard')), 'utf8');

  const loaded = await loadOperatorResearchConfig(configPath);
  assert.deepEqual(loaded.plan.preset, { id: 'standard', revision: 1 });
  assert.equal(loaded.plan.semantics.workflow.target, 'enrichment');
  assert.equal(loaded.plan.semantics.discovery.expand, true);
  assert.deepEqual(loaded.plan.semantics.enrichment?.modules, ['clusters']);
  assert.equal(loaded.plan.semantics.provenance['$.workflow.target'], 'preset');
  assert.equal(loaded.plan.semantics.provenance['$.discovery.expand'], 'preset');
  assert.equal(loaded.plan.semantics.provenance['$.enrichment.modules'], 'preset');
  assert.equal(loaded.plan.semantics.provenance['$.research.label'], 'file');
});

test('config values override preset values while inherited values retain preset provenance', async () => {
  const preset = await loadBuiltInOperatorPreset('standard');
  const authored = source('standard', {
    discovery: { expand: false },
  });
  const merged = mergeOperatorResearchConfig(authored, preset);
  const hints = buildSemanticOriginHints(authored, preset);
  const plan = buildNewResearchPlan(merged, '/tmp/project/research.config.json', {
    sourceConfig: authored,
    preset,
  });

  assert.equal(plan.semantics.discovery.expand, false);
  assert.equal(plan.semantics.discovery.topN, 10);
  assert.equal(plan.semantics.provenance['$.discovery.expand'], 'file');
  assert.equal(plan.semantics.provenance['$.discovery.topN'], 'preset');
  assert.equal(hints['$.discovery.expand'], 'file');
  assert.equal(hints['$.discovery.topN'], 'preset');
});

test('arrays replace inherited arrays instead of unioning them', async () => {
  const preset = await loadBuiltInOperatorPreset('deep-research');
  const authored = source('deep-research', {
    enrichment: { modules: ['clusters'] },
  });
  const merged = mergeOperatorResearchConfig(authored, preset);
  assert.deepEqual(merged.enrichment?.modules, ['clusters']);
});

test('nested objects merge recursively and config wins only on supplied leaves', async () => {
  const preset = await loadBuiltInOperatorPreset('finalist-validation');
  const authored = source('finalist-validation', {
    finalization: {
      historyPolicy: { youngDomainMaxAgeDays: 365 },
    },
  });
  const merged = mergeOperatorResearchConfig(authored, preset);
  assert.deepEqual(merged.finalization?.historyPolicy, {
    youngDomainMaxAgeDays: 365,
    recentWebPresenceMaxAgeDays: 1095,
    repurposeGapMinDays: 365,
  });
});

test('preset metadata is provenance only: equal effective semantics keep equal fingerprints', async () => {
  const preset = await loadBuiltInOperatorPreset('standard');
  const authored = source('standard');
  const merged = mergeOperatorResearchConfig(authored, preset);
  const presetPlan = buildNewResearchPlan(merged, '/tmp/project/research.config.json', {
    sourceConfig: authored,
    preset,
  });
  const explicit: OperatorResearchConfigV1 = {
    version: 1,
    research: { label: 'preset-test', input: { type: 'seeds', path: 'input/seeds.csv' } },
    workflow: { target: 'enrichment' },
    discovery: { topN: 10, expand: true, requireAhrefs: false },
    enrichment: { modules: ['clusters'] },
  };
  const explicitPlan = buildNewResearchPlan(explicit, '/tmp/project/research.config.json');

  assert.equal(presetPlan.effectiveConfigFingerprint, explicitPlan.effectiveConfigFingerprint);
  assert.deepEqual(presetPlan.stageFingerprints, explicitPlan.stageFingerprints);
  assert.notDeepEqual(presetPlan.semantics.provenance, explicitPlan.semantics.provenance);
});

test('unknown built-in preset fails closed', async () => {
  await assert.rejects(
    loadBuiltInOperatorPreset('definitely-not-a-preset'),
    /Unknown operator preset/,
  );
});

test('preset overlay cannot smuggle input paths or human decisions through the contract', () => {
  const illegalInput = {
    version: 1,
    id: 'bad',
    revision: 1,
    research: { input: { type: 'seeds', path: 'secret.csv' } },
  } as unknown as OperatorResearchPresetV1;
  assert.throws(
    () => mergeOperatorResearchConfig(source('bad'), illegalInput),
    /unknown field|invalid/i,
  );
});
