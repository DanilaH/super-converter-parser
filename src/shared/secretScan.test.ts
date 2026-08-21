import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsSecret, scanFilesForSecret, scanTextForSecret } from './secretScan.js';

const SENTINEL = 'AHREFS_LEAK_SENTINEL_DO_NOT_USE_zz9Z';

test('containsSecret detects the sentinel anywhere in the text', () => {
  assert.equal(containsSecret('hello world', SENTINEL), false);
  assert.equal(containsSecret(`key=${SENTINEL} extra`, SENTINEL), true);
  assert.equal(containsSecret(`x${SENTINEL}y`, SENTINEL), true);
  assert.equal(containsSecret('', SENTINEL), false);
});

test('containsSecret ignores an empty sentinel (never false-positives)', () => {
  assert.equal(containsSecret('anything', ''), false);
});

test('scanFilesForSecret finds the sentinel in any listed file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secret-scan-'));
  await writeFile(join(dir, 'a.txt'), 'clean content');
  await writeFile(join(dir, 'b.txt'), `leak here ${SENTINEL} end`);
  const files = (await readdir(dir)).map((name) => join(dir, name));
  assert.equal(await scanFilesForSecret(files, SENTINEL), true);
});

test('scanFilesForSecret returns false when no file contains the sentinel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secret-scan-clean-'));
  await writeFile(join(dir, 'a.txt'), 'clean content one');
  await writeFile(join(dir, 'b.txt'), 'clean content two');
  const files = (await readdir(dir)).map((name) => join(dir, name));
  assert.equal(await scanFilesForSecret(files, SENTINEL), false);
});

test('scanFilesForSecret tolerates missing files (no false leak)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secret-scan-missing-'));
  await writeFile(join(dir, 'a.txt'), 'clean');
  const files = [join(dir, 'a.txt'), join(dir, 'does-not-exist.txt')];
  assert.equal(await scanFilesForSecret(files, SENTINEL), false);
});

test('scanTextForSecret scans a captured log stream', () => {
  const log = 'info: run started\nwarning: rate limit\ninfo: done';
  assert.equal(scanTextForSecret(log, SENTINEL), false);
  assert.equal(scanTextForSecret(`${log}\nsecret=${SENTINEL}`, SENTINEL), true);
});
