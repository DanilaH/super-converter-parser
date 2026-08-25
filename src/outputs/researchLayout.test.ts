import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateEnrichmentDirectory,
  allocateResearchLocation,
  archiveResearchDirectory,
  researchSlug,
  resolveOutputRoot,
  resolveRunLocation,
  writeRunIndex,
} from './researchLayout.js';

test('researchSlug produces short human-readable ASCII names', () => {
  assert.equal(researchSlug('Business Days Between Dates!!!'), 'business-days-between-dates');
  assert.equal(researchSlug('  Привет  '), 'research');
  assert.ok(researchSlug('a '.repeat(100)).length <= 40);
});

test('resolveOutputRoot priority is CLI, env, then home fallback', () => {
  assert.equal(resolveOutputRoot('/cli', { RESEARCH_OUTPUT_ROOT: '/env' }, '/home/user'), '/cli');
  assert.equal(resolveOutputRoot(null, { RESEARCH_OUTPUT_ROOT: '/env' }, '/home/user'), '/env');
  assert.equal(resolveOutputRoot(null, {}, '/home/user'), '/home/user/super-converter-parser-output');
});

test('research and enrichment directories are human-readable and collision-safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-layout-'));
  const first = await allocateResearchLocation(root, 'Compare Lists', new Date('2026-08-25T00:00:00Z'));
  const second = await allocateResearchLocation(root, 'Compare Lists', new Date('2026-08-25T00:00:00Z'));
  assert.equal(first.researchDirectory, join(root, '2026-08-25-compare-lists'));
  assert.equal(second.researchDirectory, join(root, '2026-08-25-compare-lists-02'));
  assert.equal(await allocateEnrichmentDirectory(first.researchDirectory), join(first.researchDirectory, 'enrichment'));
  assert.equal(await allocateEnrichmentDirectory(first.researchDirectory), join(first.researchDirectory, 'enrichment-02'));
});

test('run index resolves independently from cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-index-'));
  const location = await allocateResearchLocation(root, 'Index Test', new Date('2026-08-25T00:00:00Z'));
  await writeFile(join(location.discoveryDirectory, 'run.sqlite'), 'sqlite');
  await writeRunIndex(root, {
    version: 1,
    runId: 'run_123',
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });
  const resolved = await resolveRunLocation(root, 'run_123', join(root, 'unrelated-worktree'));
  assert.equal(resolved.discoveryDirectory, location.discoveryDirectory);
  assert.equal(resolved.researchDirectory, location.researchDirectory);
});

test('results.zip includes final artifacts and excludes debug, WAL and itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-zip-'));
  const location = await allocateResearchLocation(root, 'Zip Test', new Date('2026-08-25T00:00:00Z'));
  await writeFile(join(location.discoveryDirectory, 'report.md'), '# report');
  await writeFile(join(location.discoveryDirectory, 'run.sqlite'), 'sqlite');
  await writeFile(join(location.discoveryDirectory, 'run.sqlite-wal'), 'wal');
  await mkdir(join(location.researchDirectory, 'debug'));
  await writeFile(join(location.researchDirectory, 'debug', 'page.html'), 'debug');

  const archive = await archiveResearchDirectory(location.researchDirectory);
  const zip = await readFile(archive);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.includes(Buffer.from('discovery/report.md')));
  assert.ok(zip.includes(Buffer.from('discovery/run.sqlite')));
  assert.equal(zip.includes(Buffer.from('run.sqlite-wal')), false);
  assert.equal(zip.includes(Buffer.from('debug/page.html')), false);
  assert.equal(zip.includes(Buffer.from('results.zip')), false);
});
