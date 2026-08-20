import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename as fsRename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildKeywordRecords, createRunDirectory, createRunId, keywordSlug, writeTextAtomic } from './run.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { ResearchError } from '../shared/errors.js';

test('buildKeywordRecords persists seed provenance in output records', () => {
  const keywords = buildSeedKeywords([
    { keyword: 'Compare Lists', rowNumber: 1 },
    { keyword: 'compare lists', rowNumber: 3 },
    { keyword: 'zip code lookup', rowNumber: 2 },
  ]);
  const records = buildKeywordRecords(keywords, 'seeds');

  assert.equal(records.length, 2);
  assert.deepEqual(records[0]!.sources, [{ type: 'seed', rowNumbers: [1, 3] }]);
  assert.deepEqual(records[1]!.sources, [{ type: 'seed', rowNumbers: [2] }]);
});

test('buildKeywordRecords emits deterministic ids and pending state', () => {
  const records = buildKeywordRecords(
    [
      { keyword: 'a', normalizedKeyword: 'a', sourceRows: [1] },
      { keyword: 'b', normalizedKeyword: 'b', sourceRows: [2] },
    ],
    'seeds',
  );

  assert.equal(records[0]!.id, 'kw-0001');
  assert.equal(records[1]!.id, 'kw-0002');
  assert.equal(records[0]!.status, 'pending');
  assert.equal(records[0]!.surfer, null);
  assert.equal(records[0]!.google, null);
  assert.equal(records[0]!.error, null);
});

test('keywordSlug produces stable artifact names', () => {
  assert.equal(keywordSlug('compare lists'), 'compare-lists');
  assert.equal(keywordSlug('  Zip! code?? '), 'zip-code');
  assert.equal(keywordSlug(''), 'keyword');
});

test('createRunId includes milliseconds and the complete injected UUID', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const uuidFactory = () => uuid;
  const id = createRunId(new Date('2026-08-15T17:30:00.000Z'), uuidFactory);

  assert.equal(id, `20260815173000000_${uuid}`);
  assert.match(
    id,
    /^\d{17}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  const oneMillisecondLater = createRunId(
    new Date('2026-08-15T17:30:00.001Z'),
    uuidFactory,
  );
  assert.ok(id < oneMillisecondLater);
});

test('createRunDirectory refuses to reuse an existing run without modifying it', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'urr-run-dir-'));
  const runDirectory = join(parent, 'existing-run');
  const markerPath = join(runDirectory, 'manifest.json');
  const marker = '{"state":"completed"}\n';

  await mkdir(runDirectory);
  await writeFile(markerPath, marker, 'utf8');

  await assert.rejects(
    createRunDirectory(runDirectory),
    (error: unknown) =>
      error instanceof ResearchError &&
      error.code === 'OUTPUT_WRITE_ERROR' &&
      error.message.includes('refusing to overwrite'),
  );
  assert.equal(await readFile(markerPath, 'utf8'), marker);
});

test('writeTextAtomic publishes content and cleans up its temp file', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'urr-text-atomic-'));
  const target = join(parent, 'keywords.csv');
  await writeTextAtomic(target, '\uFEFFa,b\r\n', 'keywords CSV');
  assert.equal(await readFile(target, 'utf8'), '\uFEFFa,b\r\n');
  const leftovers = (await readdir(parent)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('a failing rename preserves an existing target file and leaves no temp file behind', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'urr-text-fail-'));
  const target = join(parent, 'keywords.csv');
  // Existing target with known content; we must prove it survives, not that a
  // missing file stays missing.
  await writeFile(target, '\uFEFForiginal\r\n', 'utf8');
  const { setRenameForTesting } = await import('./run.js');
  setRenameForTesting(async () => {
    throw new Error('rename blocked');
  });
  try {
    await assert.rejects(
      writeTextAtomic(target, '\uFEFFnew,content\r\n', 'keywords CSV'),
      (error: unknown) => error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR',
    );
    // The existing target is byte-for-byte unchanged and the temp file is gone.
    assert.equal(await readFile(target, 'utf8'), '\uFEFForiginal\r\n');
    const leftovers = (await readdir(parent)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    setRenameForTesting(fsRename);
  }
});
