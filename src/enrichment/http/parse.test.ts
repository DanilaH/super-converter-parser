import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getContentTypeKind, extractCharset, isHtmlContentType, isTextContentType } from './parse.js';

test('getContentTypeKind: detects HTML', () => {
  assert.equal(getContentTypeKind('text/html'), 'html');
  assert.equal(getContentTypeKind('text/html; charset=utf-8'), 'html');
  assert.equal(getContentTypeKind('application/xhtml+xml'), 'html');
});

test('getContentTypeKind: detects text types', () => {
  assert.equal(getContentTypeKind('text/plain'), 'text');
  assert.equal(getContentTypeKind('text/xml'), 'text');
  assert.equal(getContentTypeKind('application/xml'), 'text');
  assert.equal(getContentTypeKind('application/json'), 'text');
  assert.equal(getContentTypeKind('text/csv'), 'text');
});

test('getContentTypeKind: detects binary types', () => {
  assert.equal(getContentTypeKind('image/png'), 'binary');
  assert.equal(getContentTypeKind('image/jpeg'), 'binary');
  assert.equal(getContentTypeKind('audio/mpeg'), 'binary');
  assert.equal(getContentTypeKind('video/mp4'), 'binary');
  assert.equal(getContentTypeKind('application/octet-stream'), 'binary');
  assert.equal(getContentTypeKind('application/pdf'), 'binary');
  assert.equal(getContentTypeKind('application/zip'), 'binary');
  assert.equal(getContentTypeKind('application/gzip'), 'binary');
});

test('getContentTypeKind: handles unknown', () => {
  assert.equal(getContentTypeKind(null), 'unknown');
  assert.equal(getContentTypeKind('application/vnd.ms-excel'), 'unknown');
});

test('extractCharset: extracts charset from content-type', () => {
  assert.equal(extractCharset('text/html; charset=utf-8'), 'utf-8');
  assert.equal(extractCharset('text/html;charset=UTF-8'), 'UTF-8');
  assert.equal(extractCharset('text/html; charset="iso-8859-1"'), 'iso-8859-1');
  assert.equal(extractCharset('text/html'), null);
  assert.equal(extractCharset(null), null);
});

test('isHtmlContentType: returns true for HTML', () => {
  assert.equal(isHtmlContentType('text/html'), true);
  assert.equal(isHtmlContentType('application/xhtml+xml; charset=utf-8'), true);
  assert.equal(isHtmlContentType('text/plain'), false);
});

test('isTextContentType: returns true for text and HTML', () => {
  assert.equal(isTextContentType('text/html'), true);
  assert.equal(isTextContentType('text/plain'), true);
  assert.equal(isTextContentType('application/json'), true);
  assert.equal(isTextContentType('image/png'), false);
});
