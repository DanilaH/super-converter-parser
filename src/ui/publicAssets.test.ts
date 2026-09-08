import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('operator browser shell is syntactically valid, external-only, and exposes create/continue/repair/metadata/batch UX', async () => {
  const base = new URL('./public/', import.meta.url);
  const [appSource, metadataSource, batchSource, repairSource, html, css, metadataCss, batchCss, repairCss] = await Promise.all([
    readFile(fileURLToPath(new URL('app.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('metadata.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('batches.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('repair.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('index.html', base)), 'utf8'),
    readFile(fileURLToPath(new URL('styles.css', base)), 'utf8'),
    readFile(fileURLToPath(new URL('metadata.css', base)), 'utf8'),
    readFile(fileURLToPath(new URL('batches.css', base)), 'utf8'),
    readFile(fileURLToPath(new URL('repair.css', base)), 'utf8'),
  ]);

  assert.doesNotThrow(() => new Function(appSource));
  assert.doesNotThrow(() => new Function(metadataSource));
  assert.doesNotThrow(() => new Function(batchSource));
  assert.doesNotThrow(() => new Function(repairSource));
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/metadata\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/batches\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/repair\.js"><\/script>/);
  assert.match(html, /id="metadata-action-root" class="metadata-action-shell hidden"/);
  assert.match(html, /id="batch-action-root" class="batch-action-shell hidden"/);
  assert.match(html, /id="repair-action-root" class="repair-action-shell repair-action hidden"/);
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/metadata\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/batches\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/repair\.css">/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);
  assert.match(html, /href="#\/new"/);

  assert.match(appSource, /\/api\/researches\/plan/);
  assert.match(appSource, /apiMutation\(`\/api\/researches\/\$\{encodeURIComponent\(status\.researchId\)\}\/resume`/);
  assert.match(appSource, /CONTINUABLE_ACTIONS/);
  assert.match(appSource, /repair_discovery/);
  assert.doesNotMatch(appSource, /innerHTML\s*=/);

  assert.match(metadataSource, /\/api\/researches\?q=/);
  assert.match(metadataSource, /candidate\.knownRunIds/);
  assert.match(metadataSource, /!item\?\.managed/);
  assert.match(metadataSource, /\/label`/);
  assert.match(metadataSource, /directory and IDs stay unchanged/);
  assert.doesNotMatch(metadataSource, /\/api\/researches\/\$\{encodeURIComponent\(routeResearchId\)\}`/);
  assert.doesNotMatch(metadataSource, /innerHTML\s*=/);

  assert.match(batchSource, /\/api\/researches\?q=/);
  assert.match(batchSource, /candidate\.knownRunIds/);
  assert.match(batchSource, /!item\?\.managed/);
  assert.match(batchSource, /\/batches\/plan`/);
  assert.match(batchSource, /\/batches`/);
  assert.match(batchSource, /previewedText = null/);
  assert.match(batchSource, /active\?\.kind === 'append_batch'/);
  assert.match(batchSource, /commit recomputes counts under the research lock/i);
  assert.doesNotMatch(batchSource, /innerHTML\s*=/);

  assert.match(repairSource, /nextAction\?\.code !== 'repair_discovery'/);
  assert.match(repairSource, /keywordCounts\?\.repairable/);
  assert.match(repairSource, /\/repair-discovery`/);
  assert.match(repairSource, /active\?\.kind === 'repair_discovery'/);
  assert.doesNotMatch(repairSource, /innerHTML\s*=/);

  assert.match(css, /textarea\.control/);
  assert.match(css, /font-size:\s*14px/);
  assert.match(metadataCss, /\.metadata-action-shell/);
  assert.match(metadataCss, /\.metadata-form/);
  assert.match(batchCss, /\.batch-action-shell/);
  assert.match(batchCss, /\.batch-preview/);
  assert.match(repairCss, /\.repair-action/);
  assert.match(repairCss, /\.repair-action-shell/);
});

test('ordinary browser continuation allowlist excludes repair and human-input gates', async () => {
  const appSource = await readFile(fileURLToPath(new URL('./public/app.js', import.meta.url)), 'utf8');
  const match = /const CONTINUABLE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/.exec(appSource);
  assert.ok(match, 'CONTINUABLE_ACTIONS declaration must remain explicit and inspectable');
  const allowlist = match[1] ?? '';

  for (const expected of ['resume_discovery', 'run_enrichment', 'resume_enrichment', 'run_finalization', 'publish_library']) {
    assert.match(allowlist, new RegExp(`'${expected}'`));
  }
  for (const forbidden of ['repair_discovery', 'shortlist', 'finalist_scope', 'human_decisions', 'supply_decisions']) {
    assert.doesNotMatch(allowlist, new RegExp(`'${forbidden}'`));
  }
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
