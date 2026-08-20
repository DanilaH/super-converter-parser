import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { readSurferRelated } from './parser.js';

// Reads the related-keywords table from the real Surfer sidebar DOM (the
// keyword-surfer-sidebar element in the main Google document) using a real
// browser, proving the parser works end-to-end against the actual structure
// (not just parseSurferRelatedRows over hand-built row objects). Skipped in
// environments without a Chromium binary.
test('browser-reader parses the real keyword-surfer-sidebar related table', async (t) => {
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch {
    t.skip(
      'playwright chromium not installed; run `npx playwright install chromium` to enable the browser-reader test',
    );
    return;
  }
  try {
    const html = await readFile(
      join('test', 'fixtures', 'surfer-related-table.html'),
      'utf8',
    );
    const page = await browser.newPage();
    await page.setContent(html);
    const rows = await readSurferRelated(page, '.keyword-surfer-sidebar', 2000);
    assert.ok(rows.length >= 1, 'expected at least one related row');
    assert.equal(rows[0]!.keyword, 'instagram');
    assert.equal(rows[0]!.overlap, 50);
    assert.equal(rows[0]!.volume, 30400000);
    assert.equal(rows[1]!.keyword, 'ig app');
  } finally {
    await browser.close();
  }
});
