import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_PATH = resolve(ROOT, 'src/gui/public/app.js');

test('operator GUI client is valid JavaScript and keeps human-decision vocabulary server-owned', async () => {
  const checked = spawnSync(process.execPath, ['--check', APP_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);

  const source = await readFile(APP_PATH, 'utf8');
  for (const serverOwnedValue of [
    'acquisition_anchor',
    'strong_supporting_tool',
    'completeness_tool',
    'experimental',
    'not_applicable',
  ]) {
    assert.equal(source.includes(serverOwnedValue), false, `client must not hardcode ${serverOwnedValue}`);
  }
});

test('operator GUI client derives config and continuation options from bootstrap schemas', async () => {
  const source = await readFile(APP_PATH, 'utf8');
  assert.match(source, /schemas\.researchConfig/);
  assert.match(source, /schemas\.continuation/);
  assert.match(source, /oneOf/);
  assert.match(source, /items\?\.enum/);
});
