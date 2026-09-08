import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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

test('browser preset selector stays in lockstep with canonical built-in preset files', async () => {
  const appSource = await readFile(fileURLToPath(new URL('./public/app.js', import.meta.url)), 'utf8');
  const presetDirectory = fileURLToPath(new URL('../../configs/presets/', import.meta.url));
  const files = (await readdir(presetDirectory))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
  const browserPresetIds = [...appSource.matchAll(/\{ id: '([a-z0-9-]+)', label: '[^']+' \}/g)]
    .map((match) => match[1] as string)
    .sort();

  assert.deepEqual(browserPresetIds, files);
});
