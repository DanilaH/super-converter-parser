import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('browser shell JavaScript is syntactically valid and HTML uses external assets', async () => {
  const base = new URL('./public/', import.meta.url);
  const [appSource, html] = await Promise.all([
    readFile(fileURLToPath(new URL('app.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('index.html', base)), 'utf8'),
  ]);

  assert.doesNotThrow(() => new Function(appSource));
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);
});
