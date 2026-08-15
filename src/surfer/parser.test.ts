import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSurferNumber } from './parser.js';

test('parseSurferNumber handles plain numbers', () => {
  assert.equal(parseSurferNumber('49500'), 49500);
  assert.equal(parseSurferNumber('49,500'), 49500);
});

test('parseSurferNumber handles currency and suffixes', () => {
  assert.equal(parseSurferNumber('$7.90'), 7.9);
  assert.equal(parseSurferNumber('1.2K'), 1200);
  assert.equal(parseSurferNumber('12K'), 12000);
  assert.equal(parseSurferNumber('1.5M'), 1500000);
  assert.equal(parseSurferNumber('2B'), 2000000000);
});

test('parseSurferNumber rejects garbage', () => {
  assert.equal(parseSurferNumber(undefined), null);
  assert.equal(parseSurferNumber(''), null);
  assert.equal(parseSurferNumber('volume'), null);
  assert.equal(parseSurferNumber('$--'), null);
  assert.equal(parseSurferNumber('1.2.3'), null);
});