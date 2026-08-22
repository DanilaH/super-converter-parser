import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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

// A real 1x1 PNG so page.png is an actual file, not a silent no-op mock.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function fakePage(content: string): Page {
  return {
    screenshot: async (options: { path: string }) => {
      await writeFile(options.path, PNG_BYTES);
    },
    content: async () => content,
  } as unknown as Page;
}

function debugContext() {
  return buildParserFailureContext(
    'compare lists',
    'https://google.com/search?q=x',
    loadConfig({} as NodeJS.ProcessEnv),
    'GOOGLE_SERP_PARSE_ERROR',
    'organic block not found',
  );
}

test('saveParserFailureArtifacts writes page.html, page.png (real), parser-context.json', async () => {
  const debugRoot = await mkdtemp(join(tmpdir(), 'debug-artifacts-'));
  const page = fakePage('<html><body>google serp snapshot</body></html>');
  const context = debugContext();

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

  const pngStat = await readFile(join(directory, 'page.png')).then((b) => b.length).catch(() => 0);
  assert.ok(pngStat > 0, 'page.png is a real non-empty file');

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

test('debug artifact containing a secret is detected by the leak scanner', async () => {
  // Positive control: if a secret ever reaches a debug artifact, the scanner must
  // catch it. Here the (fake) page HTML legitimately contains the sentinel, which
  // proves the guard actually inspects debug files rather than trusting them.
  const debugRoot = await mkdtemp(join(tmpdir(), 'debug-leak-'));
  const page = fakePage(`<html><body>page snapshot with ${SENTINEL} inside</body></html>`);
  const directory = await saveParserFailureArtifacts(
    page,
    loadConfig({} as NodeJS.ProcessEnv),
    debugRoot,
    'kw',
    debugContext(),
  );

  const leaked = await scanFilesForSecret(
    (await readdir(directory)).map((name) => join(directory, name)),
    SENTINEL,
  );
  assert.equal(leaked, true, 'a secret present in a debug artifact must be detected');
});

test('parser failure debug artifacts never contain our secret', async () => {
  const debugRoot = await mkdtemp(join(tmpdir(), 'debug-artifacts-secret-'));
  const page = fakePage('<html><body>google serp snapshot</body></html>');
  const directory = await saveParserFailureArtifacts(
    page,
    loadConfig({} as NodeJS.ProcessEnv),
    debugRoot,
    'kw',
    debugContext(),
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
