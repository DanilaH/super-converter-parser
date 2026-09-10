import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('workspace exposes persistent CSP-safe Research Chrome status with one-time setup and automatic start after setup', async () => {
  const base = new URL('./public/', import.meta.url);
  const [source, html, setupScript] = await Promise.all([
    readFile(fileURLToPath(new URL('research-chrome.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('index.html', base)), 'utf8'),
    readFile(fileURLToPath(new URL('../../scripts/research-chrome.ps1', import.meta.url)), 'utf8'),
  ]);

  assert.doesNotThrow(() => new Function(source));
  assert.match(html, /id="research-chrome-root"/);
  assert.match(html, /<script type="module" src="\/research-chrome\.js"><\/script>/);
  assert.match(source, /\/api\/system\/research-chrome/);
  assert.match(source, /\/api\/system\/research-chrome\/setup/);
  assert.match(source, /\/api\/system\/research-chrome\/start/);
  assert.match(source, /Setup once/);
  assert.doesNotMatch(source, /Start now/);
  assert.match(source, /Ready\. Discovery will start this Chrome automatically/);
  assert.match(source, /Discovery will start this Chrome automatically/);
  assert.match(source, /runner:research-chrome-refresh/);
  assert.match(source, /status\.controlSupported/);
  assert.match(source, /status\.profileReady/);
  assert.match(source, /Setup complete\. Starting Research Chrome/);
  assert.match(source, /apiMutation\('\/api\/system\/research-chrome\/start', \{\}\)/);
  assert.match(source, /Setup complete — Chrome did not start/);
  assert.doesNotMatch(source, /autoStartAttempted|autoStart:\s*true/);
  assert.doesNotMatch(source, /window\.location\.hash !== '#\/system'/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
  assert.doesNotMatch(source, /eval\(|new Function\(/);
  assert.doesNotMatch(source, /command|executable|arguments/);

  assert.match(setupScript, /robocopy .* \/R:2 \/W:1 /);
  assert.match(setupScript, /\.runner-profile-incomplete/);
  assert.match(setupScript, /Set-Content -Path \$incompleteMarker -Value "v1"/);
  assert.match(setupScript, /Remove-Item -Path \$incompleteMarker -Force/);
  assert.match(setupScript, /Close regular Chrome and retry if profile files are locked/);
});
