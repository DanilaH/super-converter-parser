import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import type { OperatorResearchConfigSourceV1, OperatorResearchConfigV1 } from './contracts.js';
import { loadBuiltInOperatorPreset, mergeOperatorResearchConfig } from './presets.js';
import { buildNewResearchPlan, type LoadedOperatorResearchConfig } from './resolve.js';
import {
  readOperatorConfigProvenance,
  writeOperatorConfigProvenance,
} from './provenance.js';

function loaded(configPath: string, market = 'US'): LoadedOperatorResearchConfig {
  const config: OperatorResearchConfigV1 = {
    version: 1,
    research: {
      label: 'portable',
      market,
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
    discovery: { topN: 10, expand: true, requireAhrefs: false },
  };
  return { config, plan: buildNewResearchPlan(config, configPath) };
}

async function loadedPreset(configPath: string): Promise<LoadedOperatorResearchConfig> {
  const sourceConfig: OperatorResearchConfigSourceV1 = {
    version: 1,
    preset: 'standard',
    research: {
      label: 'portable-preset',
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
  };
  const preset = await loadBuiltInOperatorPreset('standard');
  const config = mergeOperatorResearchConfig(sourceConfig, preset);
  return {
    config,
    sourceConfig,
    preset,
    plan: buildNewResearchPlan(config, configPath, { sourceConfig, preset }),
  };
}

test('operator config provenance is portable and round-trips with verified fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-provenance-'));
  const researchDirectory = join(root, 'research');
  await mkdir(researchDirectory);
  const configPath = join(root, 'machine-specific', 'research.config.json');
  const source = loaded(configPath);

  await writeOperatorConfigProvenance(researchDirectory, source);
  const raw = await readFile(join(researchDirectory, 'operator-config.json'), 'utf8');
  assert.equal(raw.includes(root), false);
  const persisted = await readOperatorConfigProvenance(researchDirectory);
  assert.ok(persisted);
  assert.equal(persisted.effectiveConfigFingerprint, source.plan.effectiveConfigFingerprint);
  assert.deepEqual(persisted.stageFingerprints, source.plan.stageFingerprints);
  assert.deepEqual(persisted.semantics.research.input, { type: 'seeds', logicalPath: 'input/seeds.csv' });
  assert.equal('preset' in persisted, false);
  assert.equal('effectiveConfig' in persisted, false);
});

test('operator config provenance is immutable and rejects a different effective config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-provenance-immutable-'));
  const researchDirectory = join(root, 'research');
  await mkdir(researchDirectory);
  await writeOperatorConfigProvenance(researchDirectory, loaded(join(root, 'a', 'research.config.json'), 'US'));

  await assert.rejects(
    writeOperatorConfigProvenance(researchDirectory, loaded(join(root, 'b', 'research.config.json'), 'GB')),
    (error: unknown) => error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR',
  );
});

test('operator config provenance fails closed when persisted semantics and fingerprint diverge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-provenance-corrupt-'));
  const researchDirectory = join(root, 'research');
  await mkdir(researchDirectory);
  const source = loaded(join(root, 'config', 'research.config.json'));
  await writeOperatorConfigProvenance(researchDirectory, source);
  const path = join(researchDirectory, 'operator-config.json');
  const corrupt = JSON.parse(await readFile(path, 'utf8')) as { effectiveConfigFingerprint: string };
  corrupt.effectiveConfigFingerprint = '0'.repeat(64);
  await writeFile(path, `${JSON.stringify(corrupt, null, 2)}\n`, 'utf8');

  await assert.rejects(
    readOperatorConfigProvenance(researchDirectory),
    (error: unknown) => error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR',
  );
});

test('preset-backed provenance stores the exact immutable preset snapshot and effective config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-provenance-preset-'));
  const researchDirectory = join(root, 'research');
  await mkdir(researchDirectory);
  const source = await loadedPreset(join(root, 'config', 'research.config.json'));
  await writeOperatorConfigProvenance(researchDirectory, source);

  const persisted = await readOperatorConfigProvenance(researchDirectory);
  assert.ok(persisted);
  assert.equal(persisted.authoredConfig.preset, 'standard');
  assert.deepEqual(persisted.preset, source.preset);
  assert.deepEqual(persisted.effectiveConfig, source.config);
  assert.equal(persisted.semantics.provenance['$.workflow.target'], 'preset');
  assert.equal(persisted.semantics.provenance['$.research.label'], 'file');
});

test('preset-backed provenance does not accept a changed preset revision or overlay as reinterpretation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-provenance-preset-corrupt-'));
  const researchDirectory = join(root, 'research');
  await mkdir(researchDirectory);
  const source = await loadedPreset(join(root, 'config', 'research.config.json'));
  await writeOperatorConfigProvenance(researchDirectory, source);
  const path = join(researchDirectory, 'operator-config.json');
  const persisted = JSON.parse(await readFile(path, 'utf8')) as {
    preset: { revision: number; discovery?: { expand?: boolean } };
  };

  persisted.preset.revision += 1;
  persisted.preset.discovery = { ...(persisted.preset.discovery ?? {}), expand: false };
  await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

  await assert.rejects(
    readOperatorConfigProvenance(researchDirectory),
    (error: unknown) => error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR',
  );
});
