import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import type {
  OperatorResearchConfigFileV1,
  OperatorResearchConfigV1,
  OperatorResearchPresetV1,
} from './contracts.js';
import {
  buildLoadedOperatorResearchConfig,
  buildNewResearchPlan,
  type LoadedOperatorResearchConfig,
} from './resolve.js';
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

function loadedWithPreset(configPath: string): LoadedOperatorResearchConfig {
  const authored: OperatorResearchConfigFileV1 = {
    version: 1,
    preset: 'portable-preset',
    research: {
      label: 'portable',
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
    discovery: { topN: 7 },
  };
  const preset: OperatorResearchPresetV1 = {
    version: 1,
    id: 'portable-preset',
    revision: 3,
    overlay: {
      workflow: { target: 'enrichment' },
      discovery: { topN: 10, expand: true, requireAhrefs: false },
      enrichment: { modules: ['clusters'] },
    },
  };
  return buildLoadedOperatorResearchConfig(authored, preset, configPath);
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
  assert.equal(raw.includes('"preset"'), false);
  const persisted = await readOperatorConfigProvenance(researchDirectory);
  assert.ok(persisted);
  assert.equal(persisted.effectiveConfigFingerprint, source.plan.effectiveConfigFingerprint);
  assert.deepEqual(persisted.stageFingerprints, source.plan.stageFingerprints);
  assert.deepEqual(persisted.semantics.research.input, { type: 'seeds', logicalPath: 'input/seeds.csv' });
});

test('preset provenance stores the immutable overlay snapshot and origin map', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-preset-provenance-'));
  const researchDirectory = join(root, 'research');
  await mkdir(researchDirectory);
  const source = loadedWithPreset(join(root, 'config', 'research.config.json'));

  await writeOperatorConfigProvenance(researchDirectory, source);
  const persisted = await readOperatorConfigProvenance(researchDirectory);
  assert.ok(persisted?.preset);
  assert.deepEqual(
    { id: persisted.preset.id, revision: persisted.preset.revision },
    { id: 'portable-preset', revision: 3 },
  );
  assert.equal(persisted.preset.overlay.discovery?.expand, true);
  assert.equal(persisted.semantics.provenance['$.discovery.expand'], 'preset');
  assert.equal(persisted.semantics.provenance['$.discovery.topN'], 'file');
  assert.deepEqual(persisted.stageFingerprints, source.plan.stageFingerprints);
});

test('preset provenance fails closed if the frozen overlay is changed without matching semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-preset-provenance-corrupt-'));
  const researchDirectory = join(root, 'research');
  await mkdir(researchDirectory);
  await writeOperatorConfigProvenance(
    researchDirectory,
    loadedWithPreset(join(root, 'config', 'research.config.json')),
  );
  const path = join(researchDirectory, 'operator-config.json');
  const corrupt = JSON.parse(await readFile(path, 'utf8')) as {
    preset: { overlay: { discovery: { expand: boolean } } };
  };
  corrupt.preset.overlay.discovery.expand = false;
  await writeFile(path, `${JSON.stringify(corrupt, null, 2)}\n`, 'utf8');

  await assert.rejects(
    readOperatorConfigProvenance(researchDirectory),
    (error: unknown) => error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR',
  );
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
