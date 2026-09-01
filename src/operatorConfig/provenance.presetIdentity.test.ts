import assert from 'node:assert/strict';
import test from 'node:test';
import type { OperatorResearchConfigSourceV1, OperatorResearchConfigV1 } from './contracts.js';
import { loadBuiltInOperatorPreset, mergeOperatorResearchConfig } from './presets.js';
import { buildPersistedOperatorConfig } from './provenance.js';
import { buildNewResearchPlan } from './resolve.js';

test('preset-backed portable semantics exposes immutable preset id and revision', async () => {
  const sourceConfig: OperatorResearchConfigSourceV1 = {
    version: 1,
    preset: 'standard',
    research: { label: 'preset-plan', input: { type: 'seeds', path: 'input/seeds.csv' } },
  };
  const preset = await loadBuiltInOperatorPreset('standard');
  const config = mergeOperatorResearchConfig(sourceConfig, preset);
  const plan = buildNewResearchPlan(config, '/tmp/project/research.config.json', { sourceConfig, preset });
  const persisted = buildPersistedOperatorConfig({ config, sourceConfig, preset, plan });

  assert.deepEqual(persisted.semantics.preset, { id: 'standard', revision: 1 });
});

test('no-preset portable semantics preserves the historical shape without a preset field', () => {
  const config: OperatorResearchConfigV1 = {
    version: 1,
    research: { label: 'plain', input: { type: 'seeds', path: 'input/seeds.csv' } },
  };
  const plan = buildNewResearchPlan(config, '/tmp/project/research.config.json');
  const persisted = buildPersistedOperatorConfig({ config, plan });

  assert.equal(Object.prototype.hasOwnProperty.call(persisted.semantics, 'preset'), false);
});
