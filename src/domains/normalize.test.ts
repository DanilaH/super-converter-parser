import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrableDomain } from './normalize.js';

test('two-label domain keeps its registrable domain', () => {
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('sub.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
});

test('multi-part TLD yields three labels', () => {
  assert.equal(registrableDomain('example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('site.com.au'), 'site.com.au');
});

test('rejects IP literals, bare hosts and empty input', () => {
  assert.equal(registrableDomain('127.0.0.1'), null);
  assert.equal(registrableDomain('::1'), null);
  assert.equal(registrableDomain('localhost'), null);
  assert.equal(registrableDomain('com'), null);
  assert.equal(registrableDomain(''), null);
  assert.equal(registrableDomain('   '), null);
});

test('normalizes case and trailing dot', () => {
  assert.equal(registrableDomain('EXAMPLE.COM.'), 'example.com');
});
