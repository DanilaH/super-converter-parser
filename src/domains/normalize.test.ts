import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrableDomain } from './normalize.js';

test('two-label domain keeps its registrable domain', () => {
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('sub.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
});

test('public suffix list rules handle multi-part suffixes beyond the old allowlist', () => {
  assert.equal(registrableDomain('example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('site.com.au'), 'site.com.au');
  assert.equal(registrableDomain('shop.example.co.il'), 'example.co.il');
});

test('private suffixes keep independently operated sites separate', () => {
  assert.equal(registrableDomain('user.github.io'), 'user.github.io');
  assert.equal(registrableDomain('sub.user.github.io'), 'user.github.io');
  assert.equal(registrableDomain('github.io'), null);
});

test('rejects IP literals, bare public suffixes, bare hosts and empty input', () => {
  assert.equal(registrableDomain('127.0.0.1'), null);
  assert.equal(registrableDomain('::1'), null);
  assert.equal(registrableDomain('localhost'), null);
  assert.equal(registrableDomain('com'), null);
  assert.equal(registrableDomain('co.uk'), null);
  assert.equal(registrableDomain(''), null);
  assert.equal(registrableDomain('   '), null);
});

test('keeps the helper hostname-only', () => {
  assert.equal(registrableDomain('https://example.com/path'), null);
  assert.equal(registrableDomain('user@example.com'), null);
  assert.equal(registrableDomain('example.com:443'), null);
});

test('normalizes case and trailing dot', () => {
  assert.equal(registrableDomain('EXAMPLE.COM.'), 'example.com');
});
