import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('System page loads CSP-safe Research Chrome controls with fixed API actions', async () => {
  const base = new URL('./public/', import.meta.url);
  const [source, html, setupScript] = await Promise.all([
    readFile(fileURLToPath(new URL('research-chrome.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('index.html', base)), 'utf8'),
    readFile(fileURLToPath(new URL('../../scripts/research-chrome.ps1', import.meta.url)), 'utf8'),
  ]);

  assert.doesNotThrow(() => new Function(source));
  assert.match(html, /<script type="module" src="\/research-chrome\.js"><\/script>/);
  assert.match(source, /window\.location\.hash !== '#\/system'/);
  assert.match(source, /\/api\/system\/research-chrome'/);
  assert.match(source, /\/api\/system\/research-chrome\/\$\{action\}/);
  assert.match(source, /setup \? 'Setup Research Chrome' : 'Start Research Chrome'/);
  assert.match(source, /Refresh status/);
  assert.match(source, /status\.controlSupported/);
  assert.match(source, /status\.profileReady/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
  assert.doesNotMatch(source, /eval\(|new Function\(/);
  assert.doesNotMatch(source, /command|executable|arguments/);

  assert.match(setupScript, /robocopy .* \/R:2 \/W:1 /);
  assert.match(setupScript, /Close regular Chrome and retry if profile files are locked/);
});
