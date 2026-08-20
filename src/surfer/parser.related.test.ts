import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSurferRelatedText } from './parser.js';

test('parses keyword with volume and overlap tokens', () => {
  const result = parseSurferRelatedText('compare lists 1.2K 0.9');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.keyword, 'compare lists');
  assert.equal(result[0]!.volume, 1200);
  assert.equal(result[0]!.overlap, 0.9);
  assert.equal(result[0]!.normalizedKeyword, 'compare lists');
});

test('parses multiple lines and drops empty lines', () => {
  const text = ['best laptops 50K', '', 'wireframe tool', '  '].join('\n');
  const result = parseSurferRelatedText(text);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.keyword, 'best laptops');
  assert.equal(result[0]!.volume, 50000);
  assert.equal(result[0]!.overlap, null);
  assert.equal(result[1]!.keyword, 'wireframe tool');
  assert.equal(result[1]!.volume, null);
});

test('keyword without numbers keeps null metrics', () => {
  const result = parseSurferRelatedText('mind map tool');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.keyword, 'mind map tool');
  assert.equal(result[0]!.volume, null);
  assert.equal(result[0]!.overlap, null);
});

test('empty widget yields no candidates', () => {
  assert.deepEqual(parseSurferRelatedText(''), []);
  assert.deepEqual(parseSurferRelatedText('   \n  '), []);
});
