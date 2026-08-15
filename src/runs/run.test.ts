import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeywordRecords, createRunId, keywordSlug } from './run.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';

test('buildKeywordRecords persists seed provenance in output records', () => {
  const keywords = buildSeedKeywords([
    { keyword: 'Compare Lists', rowNumber: 1 },
    { keyword: 'compare lists', rowNumber: 3 },
    { keyword: 'zip code lookup', rowNumber: 2 },
  ]);
  const records = buildKeywordRecords(keywords);

  assert.equal(records.length, 2);
  assert.deepEqual(records[0]!.sources, [{ type: 'seed', rowNumbers: [1, 3] }]);
  assert.deepEqual(records[1]!.sources, [{ type: 'seed', rowNumbers: [2] }]);
});

test('buildKeywordRecords emits deterministic ids and pending state', () => {
  const records = buildKeywordRecords([
    { keyword: 'a', normalizedKeyword: 'a', sourceRows: [1] },
    { keyword: 'b', normalizedKeyword: 'b', sourceRows: [2] },
  ]);

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

test('createRunId is compact, sortable and unique across close runs', () => {
  const id = createRunId(new Date('2026-08-15T17:30:00.000Z'));
  assert.match(id, /^\d{17}_[0-9a-f]{8}$/);

  const sameMoment = createRunId(new Date('2026-08-15T17:30:00.000Z'));
  assert.notEqual(id, sameMoment);

  const oneMillisecondLater = createRunId(new Date('2026-08-15T17:30:00.001Z'));
  assert.ok(id < oneMillisecondLater);
});