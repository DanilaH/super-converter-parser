import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import {
  saveParserFailureArtifacts,
  buildParserFailureContext,
  isParserErrorCode,
} from './artifacts.js';
import { loadConfig } from '../config/config.js';
import { scanFilesForSecret } from '../shared/secretScan.js';

// A controlled, never-real secret. Our Ahrefs API key is never part of the
// parser-failure context, so it must never appear in the debug artifacts.
const SENTINEL = 'AHREFS_LEAK_SENTINEL_DO_NOT_USE_zz9Z';

function fakePage(content: string): Page {
  return {
    screenshot: async () => undefined,
    content: async () => content,
  } as unknown as Page;
}

test('saveParserFailureArtifacts writes page.html, page.png, parser-context.json', async () => {
  const debugRoot = await mkdtemp(join(tmpdir(), 'debug-artifacts-'));
  const page = fakePage('<html><body>google serp snapshot</body></html>');
  const context = buildParserFailureContext(
    'compare lists',
    'https://google.com/search?q=x',
    loadConfig({} as NodeJS.ProcessEnv),
    'GOOGLE_SERP_PARSE_ERROR',
    'organic block not found',
  );

  const directory = await saveParserFailureArtifacts(
    page,
    loadConfig({} as NodeJS.ProcessEnv),
    debugRoot,
    'compare-lists',
    context,
  );

  const files = await readdir(directory);
  assert.ok(files.includes('page.html'), 'page.html written');
  assert.ok(files.includes('page.png'), 'page.png written');
  assert.ok(files.includes('parser-context.json'), 'parser-context.json written');

  const parsed = JSON.parse(await readFile(join(directory, 'parser-context.json'), 'utf8')) as {
    keyword: string;
    errorCode: string;
    url: string;
    selectors: { organicResults: string };
  };
  assert.equal(parsed.keyword, 'compare lists');
  assert.equal(parsed.errorCode, 'GOOGLE_SERP_PARSE_ERROR');
  assert.equal(parsed.url, 'https://google.com/search?q=x');
  assert.ok(parsed.selectors.organicResults.length > 0, 'selectors retained for debugging');
});

test('parser failure debug artifacts never contain our secret', async () => {
  const debugRoot = await mkdtemp(join(tmpdir(), 'debug-artifacts-secret-'));
  const page = fakePage('<html><body>google serp snapshot</body></html>');
  const context = buildParserFailureContext(
    'kw',
    'https://google.com/search?q=kw',
    loadConfig({} as NodeJS.ProcessEnv),
    'SURFER_PARSE_ERROR',
    'widget missing',
  );
  const directory = await saveParserFailureArtifacts(
    page,
    loadConfig({} as NodeJS.ProcessEnv),
    debugRoot,
    'kw',
    context,
  );

  const leaked = await scanFilesForSecret(
    (await readdir(directory)).map((name) => join(directory, name)),
    SENTINEL,
  );
  assert.equal(leaked, false, 'our controlled secret must never reach debug artifacts');
});

test('isParserErrorCode classifies parser failures only', () => {
  assert.equal(isParserErrorCode('GOOGLE_SERP_PARSE_ERROR'), true);
  assert.equal(isParserErrorCode('SURFER_PARSE_ERROR'), true);
  assert.equal(isParserErrorCode('SURFER_RELATED_PARSE_ERROR'), true);
  assert.equal(isParserErrorCode('SURFER_NOT_DETECTED'), true);
  assert.equal(isParserErrorCode('CAPTCHA_REQUIRED'), false);
  assert.equal(isParserErrorCode('AHREFS_RATE_LIMIT'), false);
});
