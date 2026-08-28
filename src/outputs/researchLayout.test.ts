import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchError } from '../shared/errors.js';
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
  const cliRoot = join(tmpdir(), 'output-root-cli');
  const envRoot = join(tmpdir(), 'output-root-env');
  const userHome = join(tmpdir(), 'output-root-home');

  assert.equal(resolveOutputRoot(cliRoot, { RESEARCH_OUTPUT_ROOT: envRoot }, userHome), cliRoot);
  assert.equal(resolveOutputRoot(null, { RESEARCH_OUTPUT_ROOT: envRoot }, userHome), envRoot);
  assert.equal(resolveOutputRoot(null, {}, userHome), join(userHome, 'super-converter-parser-output'));
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

test('research allocation filesystem failures are classified as OUTPUT_WRITE_ERROR', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'research-layout-blocked-'));
  const outputRoot = join(parent, 'output-root-is-a-file');
  await writeFile(outputRoot, 'not a directory', 'utf8');

  await assert.rejects(
    () => allocateResearchLocation(outputRoot, 'Blocked'),
    (error: unknown) => error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR',
  );
});

test('failed run-index publication removes the unindexed research directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-index-failure-'));
  const location = await allocateResearchLocation(root, 'Index Failure', new Date('2026-08-25T00:00:00Z'));
  await writeFile(join(location.discoveryDirectory, 'run.sqlite'), 'sqlite');
  await writeFile(join(root, 'index'), 'blocks index directory creation', 'utf8');

  await assert.rejects(
    () => writeRunIndex(root, {
      version: 1,
      runId: 'run_index_failure',
      researchDirectory: location.researchDirectory,
      discoveryDirectory: location.discoveryDirectory,
    }),
    (error: unknown) => error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR',
  );
  await assert.rejects(access(location.researchDirectory));
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
