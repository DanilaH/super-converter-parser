import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, type ResearchConfig } from '../config/config.js';
import { effectiveConfigForResume } from './runDiscoveryCore.js';
import { withCurrentExpansionAdmission } from '../runs/expansionRuntime.js';

test('resume restores the persisted current V1.1 expansion admission marker', () => {
  const current = loadConfig({});
  const persisted: ResearchConfig = {
    ...current,
    expansion: withCurrentExpansionAdmission({ ...current.expansion, enabled: true }),
  };

  const merged = effectiveConfigForResume(current, persisted, 'run-v1-1');
  assert.equal(
    (merged.expansion as ResearchConfig['expansion'] & { admissionVersion?: string }).admissionVersion,
    'v1.1',
  );
});

test('resume preserves a persisted V1 marker instead of upgrading it to V1.1', () => {
  const current = loadConfig({});
  const persisted: ResearchConfig = {
    ...current,
    expansion: {
      ...current.expansion,
      enabled: true,
      admissionVersion: 'v1',
    } as ResearchConfig['expansion'],
  };

  const merged = effectiveConfigForResume(current, persisted, 'run-v1');
  assert.equal(
    (merged.expansion as ResearchConfig['expansion'] & { admissionVersion?: string }).admissionVersion,
    'v1',
  );
});

test('resume keeps historical configs without an admission marker on legacy semantics', () => {
  const current = loadConfig({});
  const persisted = loadConfig({ EXPANSION_ENABLED: 'true' });

  const merged = effectiveConfigForResume(current, persisted, 'run-legacy');
  assert.equal(
    (merged.expansion as ResearchConfig['expansion'] & { admissionVersion?: string }).admissionVersion,
    undefined,
  );
});
