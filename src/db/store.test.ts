import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore, SCHEMA_VERSION } from './store.js';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { ResearchError } from '../shared/errors.js';

const CONFIG = loadConfig({});

const KEYWORDS = buildSeedKeywords([
  { keyword: 'compare lists', rowNumber: 1 },
  { keyword: 'best office chairs', rowNumber: 2 },
  { keyword: 'standing desk', rowNumber: 3 },
]);

function makeStore(): { store: RunStore; runId: string } {
  const store = RunStore.openInMemory();
  store.createRun({
    runId: 'run-1',
    configSnapshot: CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: KEYWORDS,
  });
  return { store, runId: 'run-1' };
}

test('fresh store is at the current schema version', () => {
  const { store } = makeStore();
  assert.equal(store.version, SCHEMA_VERSION);
  store.close();
});

test('reopening an existing store does not re-run migrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'store-reopen-'));
  const dbPath = join(directory, 'run.sqlite');
  const first = RunStore.open(dbPath);
  assert.equal(first.version, SCHEMA_VERSION);
  first.close();
  const second = RunStore.open(dbPath);
  assert.equal(second.version, SCHEMA_VERSION);
  second.close();
});

test('createRun persists run metadata and keywords in order', () => {
  const { store, runId } = makeStore();
  const run = store.loadRun(runId) as NonNullable<ReturnType<RunStore['loadRun']>>;
  assert.equal(run.state, 'created');
  assert.equal(run.input.path, 'input/seeds.csv');
  assert.equal(run.lookups, 0);
  assert.deepEqual(run.parserVersions, { surfer: '1.0.0', google: '1.0.0' });
  assert.equal(run.configSnapshot.research.topN, CONFIG.research.topN);

  const keywords = store.loadKeywords(runId);
  assert.deepEqual(
    keywords.map((item) => item.normalizedKeyword),
    ['compare lists', 'best office chairs', 'standing desk'],
  );
  assert.deepEqual(keywords[0]?.sources, [{ type: 'seed', rowNumbers: [1] }]);
  assert.equal(keywords[0]?.status, 'pending');
  store.close();
});

test('updateKeyword persists status, data, and collectedAt', () => {
  const { store, runId } = makeStore();
  const before = store.loadKeyword(runId, 0) as NonNullable<
    ReturnType<RunStore['loadKeyword']>
  >;
  store.updateKeyword(runId, {
    ...before,
    status: 'completed',
    collectedAt: '2026-01-01T00:00:00.000Z',
    surfer: { volume: 100, cpc: 1.5, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
  });
  const after = store.loadKeyword(runId, 0) as NonNullable<
    ReturnType<RunStore['loadKeyword']>
  >;
  assert.equal(after.status, 'completed');
  assert.equal(after.collectedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(after.surfer?.volume, 100);
  store.close();
});

test('replaceSerpRows overwrites previous rows for the keyword', () => {
  const { store, runId } = makeStore();
  const row = (position: number) => ({
    keyword: 'compare lists',
    position,
    title: `t${position}`,
    url: `https://example.com/${position}`,
    hostname: 'example.com',
    resultType: 'organic' as const,
  });
  store.replaceSerpRows(runId, 0, [row(1), row(2)]);
  assert.equal(store.loadSerpRows(runId).length, 2);
  store.replaceSerpRows(runId, 0, [row(1)]);
  assert.equal(store.loadSerpRows(runId).length, 1);
  store.close();
});

test('commitKeyword persists keyword and SERP rows in one write and replaces rows', () => {
  const { store, runId } = makeStore();
  const before = store.loadKeyword(runId, 0) as NonNullable<
    ReturnType<RunStore['loadKeyword']>
  >;
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      keyword: 'compare lists',
      position: index + 1,
      title: `t${index + 1}`,
      url: `https://example.com/${index + 1}`,
      hostname: 'example.com',
      resultType: 'organic' as const,
    }));

  store.commitKeyword(runId, { ...before, status: 'completed', collectedAt: '2026-01-01T00:00:00.000Z' }, rows(3));
  const after = store.loadKeyword(runId, 0) as NonNullable<
    ReturnType<RunStore['loadKeyword']>
  >;
  assert.equal(after.status, 'completed');
  assert.equal(after.collectedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(store.loadSerpRows(runId).length, 3);

  store.commitKeyword(runId, { ...after, status: 'partial' }, rows(1));
  const afterReplace = store.loadKeyword(runId, 0) as NonNullable<
    ReturnType<RunStore['loadKeyword']>
  >;
  assert.equal(afterReplace.status, 'partial');
  assert.equal(store.loadSerpRows(runId).length, 1);
  store.close();
});

test('markStaleRunningAsPending resets only running keywords', () => {
  const { store, runId } = makeStore();
  const running = store.loadKeyword(runId, 1) as NonNullable<
    ReturnType<RunStore['loadKeyword']>
  >;
  store.updateKeyword(runId, { ...running, status: 'running' });
  assert.equal(store.markStaleRunningAsPending(runId), 1);
  const keywords = store.loadKeywords(runId);
  assert.deepEqual(
    keywords.map((item) => item.status),
    ['pending', 'pending', 'pending'],
  );
  store.close();
});

test('setRunState persists pause reason', () => {
  const { store, runId } = makeStore();
  store.setRunState(runId, 'paused', { pauseReason: 'breaker' });
  const run = store.loadRun(runId) as NonNullable<ReturnType<RunStore['loadRun']>>;
  assert.equal(run.state, 'paused');
  assert.equal(run.pauseReason, 'breaker');
  store.close();
});

test('incrementLookups counts each collection attempt', () => {
  const { store, runId } = makeStore();
  assert.equal(store.incrementLookups(runId), 1);
  assert.equal(store.incrementLookups(runId), 2);
  assert.equal(store.loadRun(runId)?.lookups, 2);
  store.close();
});

test('open of a corrupt database raises DB_ERROR', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'store-corrupt-'));
  const dbPath = join(directory, 'run.sqlite');
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(dbPath, 'this is not a sqlite database', 'utf8'),
  );
  assert.throws(() => RunStore.open(dbPath), (error: unknown) => {
    return error instanceof ResearchError && error.code === 'DB_ERROR';
  });
});

test('writeJsonAtomic failure leaves no temp files behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'store-atomic-'));
  const { writeJsonAtomic } = await import('../runs/run.js');
  const target = join(directory, 'snapshot.json');
  await writeJsonAtomic(target, { ok: true }, 'test');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(() => writeJsonAtomic(target, circular, 'test'), (error: unknown) => {
    return error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR';
  });
  const contents = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(target, 'utf8'))) as { ok: boolean };
  assert.equal(contents.ok, true);
  const files = await readdir(directory);
  assert.deepEqual(files, ['snapshot.json']);
});