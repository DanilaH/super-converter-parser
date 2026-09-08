import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('operator browser shell is syntactically valid, external-only, and exposes create/continue UX', async () => {
  const base = new URL('./public/', import.meta.url);
  const [appSource, html, css] = await Promise.all([
    readFile(fileURLToPath(new URL('app.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('index.html', base)), 'utf8'),
    readFile(fileURLToPath(new URL('styles.css', base)), 'utf8'),
  ]);

  assert.doesNotThrow(() => new Function(appSource));
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);
  assert.match(html, /href="#\/new"/);

  assert.match(appSource, /\/api\/researches\/plan/);
  assert.match(appSource, /apiMutation\(`\/api\/researches\/\$\{encodeURIComponent\(status\.researchId\)\}\/resume`/);
  assert.match(appSource, /CONTINUABLE_ACTIONS/);
  assert.match(appSource, /repair_discovery/);
  assert.doesNotMatch(appSource, /innerHTML\s*=/);

  assert.match(css, /textarea\.control/);
  assert.match(css, /font-size:\s*14px/);
});
