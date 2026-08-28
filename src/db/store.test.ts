import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
    registrableDomain: 'example.com',
    dr: null,
    drStatus: null,
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
      registrableDomain: 'example.com',
      dr: null,
      drStatus: null,
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

test('commitKeyword rolls back atomically when the SERP insert fails', () => {
  const { store, runId } = makeStore();
  const row = (position: number) => ({
    keyword: 'compare lists',
    position,
    title: `t${position}`,
    url: `https://example.com/${position}`,
    hostname: 'example.com',
    registrableDomain: 'example.com',
    dr: null,
    drStatus: null,
    resultType: 'organic' as const,
  });
  store.replaceSerpRows(runId, 0, [row(1), row(2)]);

  // Break every SERP insert from inside SQLite so the transaction aborts
  // after the keyword UPDATE has already executed.
  const db = (store as unknown as { db: Database.Database }).db;
  db.exec(
    `CREATE TRIGGER serp_insert_abort BEFORE INSERT ON serp_rows
     BEGIN SELECT RAISE(ABORT, 'test injection'); END`,
  );

  const target = store.loadKeyword(runId, 0) as NonNullable<
    ReturnType<RunStore['loadKeyword']>
  >;
  assert.throws(() =>
    store.commitKeyword(
      runId,
      { ...target, status: 'completed', collectedAt: '2026-01-01T00:00:00.000Z' },
      [row(3)],
    ),
  );

  // Neither the terminal keyword status nor the previous SERP rows changed.
  const after = store.loadKeyword(runId, 0) as NonNullable<
    ReturnType<RunStore['loadKeyword']>
  >;
  assert.equal(after.status, 'pending');
  assert.equal(after.collectedAt, null);
  assert.equal(store.loadSerpRows(runId).length, 2);
  assert.equal(store.loadSerpRows(runId)[0]?.position, 1);
  assert.equal(store.loadSerpRows(runId)[1]?.position, 2);
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

const V1_SCHEMA = `
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    input_kind TEXT NOT NULL,
    input_path TEXT NOT NULL,
    config_snapshot TEXT NOT NULL,
    parser_versions TEXT NOT NULL,
    lookups INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT
  );

  CREATE TABLE keywords (
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    id TEXT NOT NULL,
    keyword TEXT NOT NULL,
    normalized_keyword TEXT NOT NULL,
    sources TEXT NOT NULL,
    status TEXT NOT NULL,
    surfer TEXT,
    google TEXT,
    error TEXT,
    collected_at TEXT,
    PRIMARY KEY (run_id, idx)
  );

  CREATE TABLE serp_rows (
    run_id TEXT NOT NULL,
    keyword_idx INTEGER NOT NULL,
    position INTEGER NOT NULL,
    keyword TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    result_type TEXT NOT NULL,
    PRIMARY KEY (run_id, keyword_idx, position)
  );
`;


test('openReadOnly reads a v1 discovery store without migrating it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-readonly-v1-'));
  const path = join(directory, 'run.sqlite');
  const v1 = new Database(path);
  v1.pragma('user_version = 1');
  v1.exec(V1_SCHEMA);
  v1.prepare(
    `INSERT INTO runs (run_id, state, created_at, updated_at, input_kind, input_path, config_snapshot, parser_versions, lookups, pause_reason)
     VALUES (?, 'completed', ?, ?, 'seeds', 'input/seeds.csv', ?, ?, 1, NULL)`,
  ).run(
    'run-1',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    JSON.stringify(CONFIG),
    JSON.stringify({ surfer: '1.0.0', google: '1.0.0' }),
  );
  v1.prepare(
    `INSERT INTO keywords (run_id, idx, id, keyword, normalized_keyword, sources, status, surfer, google, error, collected_at)
     VALUES ('run-1', 0, 'kw-0001', 'compare lists', 'compare lists', ?, 'completed', ?, ?, NULL, ?)`,
  ).run(
    JSON.stringify([{ type: 'seed', rowNumbers: [1] }]),
    JSON.stringify({ volume: 49500, cpc: 7.9, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ hl: 'en', gl: 'us' }),
    '2026-01-01T00:00:00.000Z',
  );
  v1.prepare(
    `INSERT INTO serp_rows (run_id, keyword_idx, position, keyword, title, url, hostname, result_type)
     VALUES ('run-1', 0, 1, 'compare lists', 'title', 'https://tools.example.co.uk/a', 'tools.example.co.uk', 'organic')`,
  ).run();
  v1.close();

  const source = RunStore.openReadOnly(path);
  assert.equal(source.version, 1);
  const run = source.loadRun('run-1');
  assert.ok(run);
  assert.equal(run.forceRefresh, false);
  assert.deepEqual(run.refreshKeywords, []);
  assert.equal(source.loadKeywords('run-1')[0]?.cacheStatus, null);
  assert.deepEqual(source.loadRelatedKeywords('run-1'), []);
  const serp = source.loadSerpRows('run-1');
  assert.equal(serp.length, 1);
  assert.equal(serp[0]?.registrableDomain, 'example.co.uk');
  assert.equal(serp[0]?.dr, null);
  assert.equal(serp[0]?.drStatus, null);
  assert.equal(serp[0]?.drError, null);
  source.close();

  // Read-only compatibility must never mutate a historical source run.
  const raw = new Database(path, { readonly: true });
  assert.equal(raw.pragma('user_version', { simple: true }), 1);
  const keywordColumns = raw.prepare('PRAGMA table_info(keywords)').all() as Array<{ name: string }>;
  const serpColumns = raw.prepare('PRAGMA table_info(serp_rows)').all() as Array<{ name: string }>;
  assert.ok(!keywordColumns.some((column) => column.name === 'cache_status'));
  assert.ok(!serpColumns.some((column) => column.name === 'registrable_domain'));
  raw.close();
});


test('writable stores do not hide missing current-schema related keyword tables', () => {
  const store = RunStore.openInMemory();
  const db = (store as unknown as { db: Database.Database }).db;
  db.exec('DROP TABLE related_keywords');
  assert.throws(() => store.loadRelatedKeywords('run-1'));
  store.close();
});

test('openReadOnly refuses discovery stores from a newer schema version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-readonly-future-'));
  const path = join(directory, 'run.sqlite');
  const newer = new Database(path);
  newer.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  newer.close();

  assert.throws(
    () => RunStore.openReadOnly(path),
    (error: unknown) =>
      error instanceof ResearchError &&
      error.code === 'DB_ERROR' &&
      error.message.includes('newer than this build supports'),
  );
});


test('a v1 run store migrates to the current schema with its data intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-migrate-v1-'));
  const path = join(directory, 'run.sqlite');
  const v1 = new Database(path);
  v1.pragma('user_version = 1');
  v1.exec(V1_SCHEMA);
  v1.prepare(
    `INSERT INTO runs (run_id, state, created_at, updated_at, input_kind, input_path, config_snapshot, parser_versions, lookups, pause_reason)
     VALUES (?, 'completed', ?, ?, 'seeds', 'input/seeds.csv', ?, ?, 3, NULL)`,
  ).run(
    'run-1',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    JSON.stringify(CONFIG),
    JSON.stringify({ surfer: '1.0.0', google: '1.2.0' }),
  );
  v1.prepare(
    `INSERT INTO keywords (run_id, idx, id, keyword, normalized_keyword, sources, status, surfer, google, error, collected_at)
     VALUES ('run-1', 0, 'kw-0001', 'compare lists', 'compare lists', ?, 'completed', ?, ?, NULL, ?)`,
  ).run(
    JSON.stringify([{ type: 'seed', rowNumbers: [1] }]),
    JSON.stringify({ volume: 49500 }),
    JSON.stringify({ hl: 'en', gl: 'us' }),
    '2026-01-01T00:00:00.000Z',
  );
  v1.prepare(
    `INSERT INTO serp_rows (run_id, keyword_idx, position, keyword, title, url, hostname, result_type)
     VALUES ('run-1', 0, 1, 'compare lists', 'title', 'https://example.com/1', 'example.com', 'organic')`,
  ).run();
  v1.close();

  const migrated = RunStore.open(path);
  assert.equal(migrated.version, SCHEMA_VERSION);
  const run = migrated.loadRun('run-1') as NonNullable<ReturnType<RunStore['loadRun']>>;
  // v2 columns default sanely for a migrated run.
  assert.equal(run.forceRefresh, false);
  assert.deepEqual(run.refreshKeywords, []);
  assert.equal(run.lookups, 3);
  assert.equal(run.input.path, 'input/seeds.csv');
  const keyword = migrated.loadKeywords('run-1')[0] as NonNullable<ReturnType<RunStore['loadKeywords']>>[number];
  // Terminal keywords of a pre-cache (v1) run were collected fresh, never
  // from the cache: the migration marks them 'miss' so cache accounting
  // stays complete; pending keywords keep null.
  assert.equal(keyword.cacheStatus, 'miss');
  assert.equal(keyword.surfer?.volume, 49500);
  assert.equal(migrated.loadSerpRows('run-1').length, 1);
  // The v2 columns are writable through the new contract.
  migrated.setRunCacheRefresh('run-1', true, ['standing desk']);
  assert.equal(migrated.loadRun('run-1')?.forceRefresh, true);
  migrated.close();
});

test('a v1 migration marks terminal keywords as miss and leaves pending as null', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-migrate-v1-status-'));
  const path = join(directory, 'run.sqlite');
  const v1 = new Database(path);
  v1.pragma('user_version = 1');
  v1.exec(V1_SCHEMA);
  v1.prepare(
    `INSERT INTO runs (run_id, state, created_at, updated_at, input_kind, input_path, config_snapshot, parser_versions, lookups, pause_reason)
     VALUES (?, 'paused', ?, ?, 'seeds', 'input/seeds.csv', ?, ?, 2, NULL)`,
  ).run(
    'run-1',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    JSON.stringify(CONFIG),
    JSON.stringify({ surfer: '1.0.0', google: '1.2.0' }),
  );
  const insertKeyword = v1.prepare(
    `INSERT INTO keywords (run_id, idx, id, keyword, normalized_keyword, sources, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertKeyword.run('run-1', 0, 'kw-0001', 'compare lists', 'compare lists', '[]', 'completed');
  insertKeyword.run('run-1', 1, 'kw-0002', 'best office chairs', 'best office chairs', '[]', 'partial');
  insertKeyword.run('run-1', 2, 'kw-0003', 'standing desk', 'standing desk', '[]', 'failed');
  insertKeyword.run('run-1', 3, 'kw-0004', 'ergonomic mouse', 'ergonomic mouse', '[]', 'pending');
  insertKeyword.run('run-1', 4, 'kw-0005', 'broken keyword', 'broken keyword', '[]', 'running');
  v1.close();

  const migrated = RunStore.open(path);
  assert.deepEqual(
    migrated.loadKeywords('run-1').map((keyword) => keyword.cacheStatus),
    ['miss', 'miss', 'miss', null, null],
  );
  migrated.close();
});

test('a failed run-store migration rolls back atomically and leaves the old version intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-migrate-rollback-'));
  const path = join(directory, 'run.sqlite');
  const v1 = new Database(path);
  v1.pragma('user_version = 1');
  // v1 schema but runs already has a "force_refresh" column, so the v2 ALTER
  // ADD COLUMN must fail; the transaction must roll back everything.
  v1.exec(V1_SCHEMA.replace(
    'pause_reason TEXT',
    'pause_reason TEXT,\n    force_refresh INTEGER NOT NULL DEFAULT 0',
  ));
  v1.prepare(
    `INSERT INTO runs (run_id, state, created_at, updated_at, input_kind, input_path, config_snapshot, parser_versions, lookups, pause_reason)
     VALUES (?, 'created', ?, ?, 'seeds', 'input/seeds.csv', ?, ?, 0, NULL)`,
  ).run(
    'run-1',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    JSON.stringify(CONFIG),
    JSON.stringify({ surfer: '1.0.0', google: '1.2.0' }),
  );
  v1.prepare(
    `INSERT INTO keywords (run_id, idx, id, keyword, normalized_keyword, sources, status)
     VALUES ('run-1', 0, 'kw-0001', 'compare lists', 'compare lists', ?, 'pending')`,
  ).run(JSON.stringify([{ type: 'seed', rowNumbers: [1] }]));
  v1.close();

  assert.throws(
    () => RunStore.open(path),
    (error: unknown) =>
      error instanceof ResearchError &&
      error.code === 'DB_ERROR' &&
      error.message.includes('migration v2 failed'),
  );

  // The failed migration left the file fully usable at v1 with its data.
  const raw = new Database(path);
  assert.equal(raw.pragma('user_version', { simple: true }), 1);
  assert.equal((raw.prepare('SELECT COUNT(*) AS c FROM runs').get() as { c: number }).c, 1);
  const columns = raw.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
  assert.ok(!columns.some((column) => column.name === 'refresh_keywords'));
  raw.close();
});

test('a run store from a newer schema version is refused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-migrate-future-'));
  const path = join(directory, 'run.sqlite');
  const newer = new Database(path);
  newer.pragma('user_version = 99');
  newer.close();
  assert.throws(
    () => RunStore.open(path),
    (error: unknown) =>
      error instanceof ResearchError &&
      error.code === 'DB_ERROR' &&
      error.message.includes('newer than this build supports'),
  );
});
