import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildOutputDiagnostics } from './outputDiagnostics.js';

test('output diagnostics reports canonical layout and repo-local legacy directories', async () => {
  const home = await mkdtemp(join(tmpdir(), 'output-diagnostics-home-'));
  const cwd = await mkdtemp(join(tmpdir(), 'output-diagnostics-cwd-'));
  const root = join(home, 'configured-output');
  await mkdir(root, { recursive: true });
  await mkdir(join(cwd, 'runs'));
  await mkdir(join(cwd, 'output'));

  const result = await buildOutputDiagnostics({
    userHome: home,
    cwd,
    env: { RESEARCH_OUTPUT_ROOT: root },
  });

  assert.equal(result.canonicalRoot, root);
  assert.equal(result.configuredBy, 'RESEARCH_OUTPUT_ROOT');
  assert.equal(result.rootExists, true);
  assert.equal(result.researchesDirectoryExists, false);
  assert.equal(result.overrideEscapeHatchEnabled, false);
  assert.deepEqual(result.repoLocalLegacyDirectories, [join(cwd, 'runs'), join(cwd, 'output')]);
  assert.equal(result.layout.researches, join(root, 'researches'));
});

test('output diagnostics exposes override escape-hatch state without changing the canonical root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'output-diagnostics-home-'));
  const cwd = await mkdtemp(join(tmpdir(), 'output-diagnostics-cwd-'));
  const result = await buildOutputDiagnostics({
    userHome: home,
    cwd,
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
  });

  assert.equal(result.canonicalRoot, join(home, 'super-converter-parser-output'));
  assert.equal(result.configuredBy, 'home_default');
  assert.equal(result.overrideEscapeHatchEnabled, true);
});
