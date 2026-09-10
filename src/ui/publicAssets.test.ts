import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('operator browser shell is syntactically valid, external-only, and exposes create/continue/repair/metadata/batch/human-gate UX', async () => {
  const base = new URL('./public/', import.meta.url);
  const [
    appSource,
    batchSource,
    metadataSource,
    repairSource,
    shortlistSource,
    finalistSource,
    decisionSource,
    html,
    css,
    batchCss,
    metadataCss,
    repairCss,
    shortlistCss,
    finalistCss,
    decisionCss,
  ] = await Promise.all([
    readFile(fileURLToPath(new URL('app.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('batches.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('metadata.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('repair.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('shortlist.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('finalists.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('decisions.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('index.html', base)), 'utf8'),
    readFile(fileURLToPath(new URL('styles.css', base)), 'utf8'),
    readFile(fileURLToPath(new URL('batches.css', base)), 'utf8'),
    readFile(fileURLToPath(new URL('metadata.css', base)), 'utf8'),
    readFile(fileURLToPath(new URL('repair.css', base)), 'utf8'),
    readFile(fileURLToPath(new URL('shortlist.css', base)), 'utf8'),
    readFile(fileURLToPath(new URL('finalists.css', base)), 'utf8'),
    readFile(fileURLToPath(new URL('decisions.css', base)), 'utf8'),
  ]);

  assert.doesNotThrow(() => new Function(appSource));
  assert.doesNotThrow(() => new Function(batchSource));
  assert.doesNotThrow(() => new Function(metadataSource));
  assert.doesNotThrow(() => new Function(repairSource));
  assert.doesNotThrow(() => new Function(shortlistSource));
  assert.doesNotThrow(() => new Function(finalistSource));
  assert.doesNotThrow(() => new Function(decisionSource));
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/batches\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/metadata\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/repair\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/shortlist\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/finalists\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/decisions\.js"><\/script>/);
  assert.match(html, /id="batch-action-root" class="batch-action-shell hidden"/);
  assert.match(html, /id="metadata-action-root" class="metadata-action-shell hidden"/);
  assert.match(html, /id="repair-action-root" class="repair-action-shell repair-action hidden"/);
  assert.match(html, /id="shortlist-action-root" class="shortlist-action-shell hidden"/);
  assert.match(html, /id="finalist-action-root" class="finalist-action-shell hidden"/);
  assert.match(html, /id="decision-action-root" class="decision-action-shell hidden"/);
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/batches\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/metadata\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/repair\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/shortlist\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/finalists\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/decisions\.css">/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);
  assert.match(html, /href="#\/new"/);

  assert.match(appSource, /\/api\/researches\/plan/);
  assert.match(appSource, /apiMutation\(`\/api\/researches\/\$\{encodeURIComponent\(status\.researchId\)\}\/resume`/);
  assert.match(appSource, /CONTINUABLE_ACTIONS/);
  assert.match(appSource, /app\.dataset\.researchId\s*=\s*status\.researchId/);
  assert.match(appSource, /app\.dataset\.nextActionCode/);
  assert.match(appSource, /app\.dataset\.humanRequirement\s*=\s*humanRequirement/);
  assert.match(appSource, /app\.dataset\.repairable/);
  assert.match(appSource, /function researchIdFromHash/);
  assert.match(appSource, /decodeURIComponent/);
  assert.doesNotMatch(appSource, /Preview plan/);
  assert.match(appSource, /Start discovery/);
  assert.match(appSource, /previewStageLabel\(stage, index\)/);
  assert.match(appSource, /node\('span', \{ text: previewStageLabel\(stage, index\) \}\)/);
  assert.match(appSource, /stage\.state === 'not_requested'\) return 'Not included'/);
  assert.match(appSource, /Next: run enrichment/);
  assert.match(appSource, /className: 'button primary workflow-action'/);
  assert.match(appSource, /onSnapshot: \(job\) => \{[\s\S]*window\.location\.hash = `#\/research\/\$\{encodeURIComponent\(job\.researchId\)\}`/);
  assert.match(appSource, /active\.kind === 'create_research'/);
  assert.match(appSource, /Another research action is running\. You can start a new research when it finishes\./);
  assert.doesNotMatch(appSource, /kvRow\('Stop point'/);
  assert.doesNotMatch(appSource, /kvRow\('Exit code'/);
  assert.doesNotMatch(appSource, /nextActionRequiresInput/);
  assert.doesNotMatch(appSource, /will be added in U2\.3/);
  assert.doesNotMatch(appSource, /innerHTML\s*=/);

  assert.match(batchSource, /\/api\/researches\?q=/);
  assert.match(batchSource, /candidate\.knownRunIds/);
  assert.match(batchSource, /!item\?\.managed/);
  assert.match(batchSource, /\/batches\/plan`/);
  assert.match(batchSource, /\/batches`/);
  assert.match(batchSource, /previewedText !== textarea\.value/);
  assert.match(batchSource, /active\?\.kind === 'append_batch'/);
  assert.doesNotMatch(batchSource, /innerHTML\s*=/);

  assert.match(metadataSource, /\/api\/researches\?q=/);
  assert.match(metadataSource, /candidate\.knownRunIds/);
  assert.match(metadataSource, /!item\?\.managed/);
  assert.match(metadataSource, /\/label`/);
  assert.match(metadataSource, /directory and IDs stay unchanged/);
  assert.doesNotMatch(metadataSource, /\/api\/researches\/\$\{encodeURIComponent\(routeResearchId\)\}`/);
  assert.doesNotMatch(metadataSource, /innerHTML\s*=/);

  assert.match(repairSource, /app\.dataset\.nextActionCode/);
  assert.match(repairSource, /app\.dataset\.repairable/);
  assert.match(repairSource, /\/repair-discovery`/);
  assert.match(repairSource, /active\?\.kind === 'repair_discovery'/);
  assert.doesNotMatch(repairSource, /api\(`\/api\/researches\/\$\{encodeURIComponent\(researchId\)\}`\)/);
  assert.doesNotMatch(repairSource, /syncRepairNote|Repair remains explicit/);
  assert.doesNotMatch(repairSource, /innerHTML\s*=/);

  assert.match(shortlistSource, /\/api\/researches\/\$\{encodeURIComponent\(routeResearchId\)\}\/shortlist/);
  assert.match(shortlistSource, /app\.dataset\.humanRequirement/);
  assert.match(shortlistSource, /currentGateResearchId\('shortlist'\)/);
  assert.match(shortlistSource, /Could not load the shortlist step/);
  assert.match(shortlistSource, /discoveryRunId:\s*gate\.discoveryRunId/);
  assert.match(shortlistSource, /normalizedKeywords:\s*keywords/);
  assert.match(shortlistSource, /Select filtered/);
  assert.match(shortlistSource, /gate\.minSelection/);
  assert.match(shortlistSource, /gate\.maxSelection/);
  assert.match(shortlistSource, /Start enrichment with \${count}/);
  assert.match(shortlistSource, /let submitting = false/);
  assert.match(shortlistSource, /Your current shortlist is still selected/);
  assert.doesNotMatch(shortlistSource, /shortlistHintIsRendered|title === 'Run Enrichment'|nextActionRequiresInput/);
  assert.doesNotMatch(shortlistSource, /innerHTML\s*=/);

  assert.match(finalistSource, /\/api\/researches\/\$\{encodeURIComponent\(routeResearchId\)\}\/finalist-scope/);
  assert.match(finalistSource, /app\.dataset\.humanRequirement/);
  assert.match(finalistSource, /currentGateResearchId\('finalist_scope'\)/);
  assert.match(finalistSource, /Could not load the finalization-scope step/);
  assert.match(finalistSource, /enrichmentId:\s*gate\.enrichmentId/);
  assert.match(finalistSource, /mode:\s*'selected'/);
  assert.match(finalistSource, /clusterIds/);
  assert.match(finalistSource, /mode:\s*'all'/);
  assert.match(finalistSource, /Start finalization: all \$\{gate\.clusterCount\}/);
  assert.match(finalistSource, /not recommendation order/);
  assert.match(finalistSource, /Start finalization: \${count} selected/);
  assert.match(finalistSource, /allButton\.className = `button \${count === 0 \? 'primary' : ''}`/);
  assert.match(finalistSource, /Your current cluster selection is still here/);
  assert.doesNotMatch(finalistSource, /finalistScopeHintIsRendered|title === 'Run Finalization'|nextActionRequiresInput/);
  assert.doesNotMatch(finalistSource, /innerHTML\s*=/);

  assert.match(decisionSource, /\/api\/researches\/\$\{encodeURIComponent\(researchId\)\}\/decisions/);
  assert.match(decisionSource, /app\.dataset\.humanRequirement/);
  assert.match(decisionSource, /currentGateResearchId\('human_decisions'\)/);
  assert.match(decisionSource, /Could not load the decision step/);
  assert.match(decisionSource, /representativeRevision:\s*gate\.representativeRevision/);
  assert.match(decisionSource, /entrantFingerprint:\s*gate\.entrantFingerprint/);
  assert.match(decisionSource, /decisionStateUpdatedAt:\s*gate\.decisionStateUpdatedAt/);
  assert.match(decisionSource, /buildDecision:\s*current\.buildDecision/);
  assert.match(decisionSource, /seoProductRole:\s*current\.seoProductRole/);
  assert.match(decisionSource, /unfinished rows can be saved and completed later/);
  assert.match(decisionSource, /Finish research/);
  assert.match(decisionSource, /let submitting = false/);
  assert.match(decisionSource, /Your unsaved choices are still here/);
  assert.doesNotMatch(decisionSource, /decisionHintIsRendered|title === 'Supply Decisions'|nextActionRequiresInput/);
  assert.doesNotMatch(decisionSource, /innerHTML\s*=/);

  assert.match(css, /textarea\.control/);
  assert.match(css, /font-size:\s*14px/);
  assert.match(batchCss, /\.batch-action-shell/);
  assert.match(batchCss, /\.batch-form/);
  assert.match(metadataCss, /\.metadata-action-shell/);
  assert.match(metadataCss, /\.metadata-form/);
  assert.match(repairCss, /\.repair-action/);
  assert.match(repairCss, /\.repair-action-shell/);
  assert.match(shortlistCss, /\.shortlist-action-shell/);
  assert.match(shortlistCss, /\.shortlist-table/);
  assert.match(shortlistCss, /\.shortlist-footer[\s\S]*position:\s*sticky/);
  assert.match(finalistCss, /\.finalist-action-shell/);
  assert.match(finalistCss, /\.finalist-card/);
  assert.match(finalistCss, /\.finalist-footer[\s\S]*position:\s*sticky/);
  assert.match(decisionCss, /\.decision-action-shell/);
  assert.match(decisionCss, /\.decision-card/);
  assert.match(decisionCss, /\.decision-footer[\s\S]*position:\s*sticky/);
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
