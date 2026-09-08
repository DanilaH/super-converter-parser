import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  resolveOperatorContinuationInput,
  resolveOperatorResearchConfigInput,
} from './operatorInputs.js';

test('resolveOperatorResearchConfigInput preserves declaring-path semantics without a JSON read', async () => {
  const declaringPath = resolve('/workspace/ui/research.config.json');
  const loaded = await resolveOperatorResearchConfigInput({
    version: 1,
    research: {
      label: 'UI research',
      input: { type: 'seeds', path: './inputs/seeds.csv' },
    },
    workflow: { target: 'discovery' },
  }, declaringPath);

  assert.equal(loaded.config.research.label, 'UI research');
  assert.equal(loaded.plan.configPath, declaringPath);
  assert.equal(loaded.plan.semantics.research.input.logicalPath, 'inputs/seeds.csv');
  assert.equal(loaded.plan.semantics.research.input.resolvedPath, join(resolve('/workspace/ui'), 'inputs', 'seeds.csv'));
});

test('resolveOperatorContinuationInput preserves declaring-path semantics for path-bearing actions', () => {
  const declaringPath = resolve('/workspace/ui/continuation.json');
  const resolved = resolveOperatorContinuationInput({
    version: 1,
    researchId: 'research-1',
    action: { type: 'shortlist', path: './inputs/shortlist.csv' },
  }, declaringPath);

  assert.equal(resolved.continuationPath, declaringPath);
  assert.equal(resolved.declaredFilePath?.logicalPath, 'inputs/shortlist.csv');
  assert.equal(resolved.declaredFilePath?.resolvedPath, join(resolve('/workspace/ui'), 'inputs', 'shortlist.csv'));
});

test('resolveOperatorContinuationInput needs no synthetic file path for inline continuation actions', () => {
  const resolved = resolveOperatorContinuationInput({
    version: 1,
    researchId: 'research-1',
    action: { type: 'finalists_all' },
  }, resolve('/workspace/ui/continuation.json'));

  assert.equal(resolved.declaredFilePath, null);
});
