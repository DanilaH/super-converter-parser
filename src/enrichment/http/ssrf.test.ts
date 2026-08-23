import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, checkUrlAllowed, buildPinnedUrl, getValidatedHostHeader } from './ssrf.js';

test('isPrivateIp: detects RFC1918 IPv4 ranges', () => {
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('10.255.255.255'), true);
  assert.equal(isPrivateIp('172.16.0.1'), true);
  assert.equal(isPrivateIp('172.31.255.255'), true);
  assert.equal(isPrivateIp('172.15.0.1'), false);
  assert.equal(isPrivateIp('172.32.0.1'), false);
  assert.equal(isPrivateIp('192.168.0.1'), true);
  assert.equal(isPrivateIp('192.168.255.255'), true);
});

test('isPrivateIp: detects loopback', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('127.255.255.255'), true);
});

test('isPrivateIp: detects link-local', () => {
  assert.equal(isPrivateIp('169.254.0.1'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
});

test('isPrivateIp: detects CGNAT (100.64.0.0/10)', () => {
  assert.equal(isPrivateIp('100.64.0.1'), true);
  assert.equal(isPrivateIp('100.127.255.255'), true);
  assert.equal(isPrivateIp('100.63.255.255'), false);
  assert.equal(isPrivateIp('100.128.0.1'), false);
});

test('isPrivateIp: detects IPv6 private', () => {
  assert.equal(isPrivateIp('fc00::1'), true);
  assert.equal(isPrivateIp('fd00::1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('::'), true);
});

test('isPrivateIp: detects IPv4-mapped IPv6 private', () => {
  assert.equal(isPrivateIp('::ffff:192.168.1.1'), true);
  assert.equal(isPrivateIp('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
});

test('isPrivateIp: detects metadata IPs', () => {
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('100.100.100.200'), true);
});

test('isPrivateIp: allows public IPs', () => {
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);
  assert.equal(isPrivateIp('203.0.113.1'), false);
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false);
});

test('checkUrlAllowed: rejects non-http schemes', async () => {
  const result = await checkUrlAllowed('ftp://example.com/file');
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /Disallowed scheme/);
});

test('checkUrlAllowed: rejects invalid URLs', async () => {
  const result = await checkUrlAllowed('not-a-url');
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /Invalid URL/);
});

test('checkUrlAllowed: rejects localhost', async () => {
  const result = await checkUrlAllowed('http://localhost:8080/path');
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /localhost/);
});

test('checkUrlAllowed: rejects private IP literals', async () => {
  const result = await checkUrlAllowed('http://192.168.1.1/path');
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /Blocked IP/);
});

test('checkUrlAllowed: rejects metadata IP', async () => {
  const result = await checkUrlAllowed('http://169.254.169.254/latest/meta-data');
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /Blocked IP/);
});

test('checkUrlAllowed: rejects IPv4-mapped IPv6 private', async () => {
  const result = await checkUrlAllowed('http://[::ffff:192.168.1.1]/path');
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /Blocked IP/);
});

test('checkUrlAllowed: allows public IP literals', async () => {
  const result = await checkUrlAllowed('http://8.8.8.8/path');
  assert.equal(result.allowed, true);
});

test('checkUrlAllowed: returns all validated IPs', async () => {
  const result = await checkUrlAllowed('http://127.0.0.1/path');
  assert.equal(result.allowed, false);
  assert.ok(result.reason);
});

test('buildPinnedUrl: replaces hostname with validated IPv4', () => {
  const pinned = buildPinnedUrl('http://example.com/page', '93.184.216.34');
  assert.equal(pinned, 'http://93.184.216.34/page');
});

test('buildPinnedUrl: replaces hostname with validated IPv6', () => {
  const pinned = buildPinnedUrl('http://example.com/page', '2001:db8::1');
  assert.equal(pinned, 'http://[2001:db8::1]/page');
});

test('getValidatedHostHeader: extracts host with port', () => {
  assert.equal(getValidatedHostHeader('http://example.com:8080/path'), 'example.com:8080');
});

test('getValidatedHostHeader: extracts host without port', () => {
  assert.equal(getValidatedHostHeader('https://example.com/path'), 'example.com');
});
