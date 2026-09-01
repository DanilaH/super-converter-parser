import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { loadOperatorResearchConfig } from './resolve.js';

test('PR G live acceptance fixture resolves through the production config contract', async () => {
  const configPath = resolve('configs/acceptance/pr-g-live/research.config.json');
  const loaded = await loadOperatorResearchConfig(configPath);

  assert.deepEqual(loaded.plan.preset, { id: 'finalist-validation', revision: 1 });
  assert.equal(loaded.plan.semantics.workflow.target, 'finalization');
  assert.equal(loaded.plan.semantics.discovery.expand, false);
  assert.equal(loaded.plan.semantics.discovery.requireAhrefs, false);
  assert.deepEqual(loaded.plan.semantics.enrichment?.modules, ['clusters']);
  assert.equal(loaded.plan.semantics.research.input.logicalPath, 'seeds.csv');
  assert.equal(
    loaded.plan.semantics.research.input.resolvedPath,
    resolve('configs/acceptance/pr-g-live/seeds.csv'),
  );
  assert.deepEqual(loaded.plan.unresolvedHumanRequirements, ['finalist_scope', 'human_decisions']);
});
