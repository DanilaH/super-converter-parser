import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { OperatorResearchConfigV1 } from './contracts.js';
import { buildNewResearchPlan, canonicalJson, loadOperatorContinuation, loadOperatorResearchConfig, resolveDeclaredPath } from './resolve.js';

function finalizationConfig(overrides: Partial<OperatorResearchConfigV1> = {}): OperatorResearchConfigV1 {
  return { version: 1, research: { label: 'json-tools', market: 'US', googleHl: 'en', googleGl: 'us', input: { type: 'seeds', path: 'input/seeds.csv' } }, workflow: { target: 'finalization' }, discovery: { expand: true, requireAhrefs: false }, enrichment: { modules: ['clusters', 'query_suggestions', 'domain_age', 'pages', 'site_structure'], clustering: { topN: 10, minSharedDomains: 3, minDomainJaccard: 0.3, minSharedUrls: 2, minUrlJaccard: 0.1 } }, finalization: { representativeCount: 5, historyPolicy: { youngDomainMaxAgeDays: 730, recentWebPresenceMaxAgeDays: 1095, repurposeGapMinDays: 365 }, historicalPresence: { collectionMode: 'annual', recentMonths: 18, maxCollections: 24, domainCap: 30 } }, ...overrides };
}

test('declared paths resolve relative to the declaring JSON file and normalize separators', () => {
  const result = resolveDeclaredPath(resolve('/tmp/project/config/research.config.json'), '..\\input\\seeds.csv');
  assert.equal(result.logicalPath, '../input/seeds.csv');
  assert.equal(result.resolvedPath, resolve('/tmp/project/input/seeds.csv'));
});

test('loader resolves research input independent of the process working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-config-')); const configDir = join(root, 'configs');
  await mkdir(join(configDir, 'input'), { recursive: true }); const configPath = join(configDir, 'research.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, research: { label: 'portable', input: { type: 'seeds', path: 'input/seeds.csv' } } }), 'utf8');
  const loaded = await loadOperatorResearchConfig(configPath);
  assert.equal(loaded.plan.semantics.research.input.logicalPath, 'input/seeds.csv');
  assert.equal(loaded.plan.semantics.research.input.resolvedPath, join(configDir, 'input', 'seeds.csv'));
});

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 2, a: { y: 2, x: 1 } }), canonicalJson({ a: { x: 1, y: 2 }, b: 2 }));
});

test('same effective config gets stable fingerprints even when defaults are explicit', () => {
  const configPath = resolve('/tmp/project/research.config.json');
  const implicit: OperatorResearchConfigV1 = { version: 1, research: { label: 'same', input: { type: 'seeds', path: 'input/seeds.csv' } } };
  const explicit: OperatorResearchConfigV1 = { version: 1, research: { label: 'same', market: 'US', googleHl: 'en', googleGl: 'us', input: { type: 'seeds', path: './input/seeds.csv' } }, workflow: { target: 'discovery' }, discovery: { expand: false, requireAhrefs: false } };
  const a = buildNewResearchPlan(implicit, configPath); const b = buildNewResearchPlan(explicit, configPath);
  assert.equal(a.effectiveConfigFingerprint, b.effectiveConfigFingerprint);
  assert.deepEqual(a.stageFingerprints, b.stageFingerprints);
});

test('new plan exposes required and conditional external work without invoking providers', () => {
  const configPath = resolve('/tmp/project/research.config.json');
  const plan = buildNewResearchPlan(finalizationConfig(), configPath);
  assert.deepEqual(plan.externalWork.map((item) => item.stage), ['discovery', 'enrichment', 'finalization']);
  const discovery = plan.externalWork.find((item) => item.stage === 'discovery')?.providers ?? [];
  const enrichment = plan.externalWork.find((item) => item.stage === 'enrichment')?.providers ?? [];
  assert.ok(discovery.includes('google'));
  assert.ok(discovery.includes('ahrefs_if_configured'));
  assert.ok(enrichment.includes('first_seen_provider_if_configured'));
  assert.ok(plan.externalWork.find((item) => item.stage === 'finalization')?.providers.includes('common_crawl'));

  const requiredAhrefs = buildNewResearchPlan(finalizationConfig({ discovery: { expand: true, requireAhrefs: true } }), configPath);
  const requiredDiscovery = requiredAhrefs.externalWork.find((item) => item.stage === 'discovery')?.providers ?? [];
  assert.ok(requiredDiscovery.includes('ahrefs'));
  assert.ok(!requiredDiscovery.includes('ahrefs_if_configured'));
});

test('query suggestion defaults are stable and query suggestion changes stay enrichment-local', () => {
  const configPath = resolve('/tmp/project/research.config.json');
  const baseConfig = finalizationConfig();
  const implicit = buildNewResearchPlan(baseConfig, configPath);
  const explicit = buildNewResearchPlan(finalizationConfig({ enrichment: {
    ...baseConfig.enrichment!, querySuggestions: { sources: ['surfer_related', 'google_autocomplete', 'google_related_search', 'google_paa'], maxSuggestionsPerSource: 20, maxParents: 200 },
  } }), configPath);
  assert.equal(implicit.stageFingerprints.enrichmentSemanticFingerprint, explicit.stageFingerprints.enrichmentSemanticFingerprint);
  const changed = buildNewResearchPlan(finalizationConfig({ enrichment: {
    ...baseConfig.enrichment!, querySuggestions: { sources: ['surfer_related', 'google_autocomplete'], maxSuggestionsPerSource: 10, maxParents: 50 },
  } }), configPath);
  assert.equal(implicit.stageFingerprints.discoverySemanticFingerprint, changed.stageFingerprints.discoverySemanticFingerprint);
  assert.notEqual(implicit.stageFingerprints.enrichmentSemanticFingerprint, changed.stageFingerprints.enrichmentSemanticFingerprint);
  assert.equal(implicit.stageFingerprints.finalizationPolicyFingerprint, changed.stageFingerprints.finalizationPolicyFingerprint);
});

test('later-stage policy changes do not invalidate discovery semantics', () => {
  const configPath = resolve('/tmp/project/research.config.json'); const base = buildNewResearchPlan(finalizationConfig(), configPath);
  const changed = buildNewResearchPlan(finalizationConfig({ finalization: { representativeCount: 7, historyPolicy: { youngDomainMaxAgeDays: 1000, recentWebPresenceMaxAgeDays: 1095, repurposeGapMinDays: 365 }, historicalPresence: { collectionMode: 'annual', recentMonths: 18, maxCollections: 12, domainCap: 20 } } }), configPath);
  assert.equal(base.stageFingerprints.discoverySemanticFingerprint, changed.stageFingerprints.discoverySemanticFingerprint);
  assert.equal(base.stageFingerprints.enrichmentSemanticFingerprint, changed.stageFingerprints.enrichmentSemanticFingerprint);
  assert.notEqual(base.stageFingerprints.finalizationPolicyFingerprint, changed.stageFingerprints.finalizationPolicyFingerprint);
});

test('discovery semantic changes affect discovery fingerprint without absolute-path dependence', () => {
  const config = finalizationConfig(); const a = buildNewResearchPlan(config, resolve('/machine-a/project/research.config.json')); const b = buildNewResearchPlan(config, resolve('/machine-b/project/research.config.json'));
  assert.equal(a.stageFingerprints.discoverySemanticFingerprint, b.stageFingerprints.discoverySemanticFingerprint);
  assert.notEqual(a.semantics.research.input.resolvedPath, b.semantics.research.input.resolvedPath);
  const changedMarket = finalizationConfig({ research: { ...config.research, market: 'GB', googleGl: 'gb' } });
  const c = buildNewResearchPlan(changedMarket, resolve('/machine-a/project/research.config.json'));
  assert.notEqual(a.stageFingerprints.discoverySemanticFingerprint, c.stageFingerprints.discoverySemanticFingerprint);
});

test('new finalization plan exposes human gates instead of inventing choices', () => {
  const plan = buildNewResearchPlan(finalizationConfig(), resolve('/tmp/project/research.config.json'));
  assert.deepEqual(plan.unresolvedHumanRequirements, ['shortlist', 'finalist_scope', 'human_decisions']);
  assert.deepEqual(plan.stages.map((stage) => [stage.id, stage.state]), [['discovery', 'ready'], ['enrichment', 'blocked'], ['finalization', 'blocked']]);
  assert.equal(plan.expectedStopPoint, 'discovery');
});

test('continuation file paths resolve relative to the continuation file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-continuation-')); const continuationDir = join(root, 'continuations');
  await mkdir(join(continuationDir, 'inputs'), { recursive: true }); const continuationPath = join(continuationDir, 'shortlist.json');
  await writeFile(continuationPath, JSON.stringify({ version: 1, researchId: 'research-123', action: { type: 'shortlist', path: 'inputs/shortlist.csv' } }), 'utf8');
  const loaded = await loadOperatorContinuation(continuationPath);
  assert.equal(loaded.continuation.researchId, 'research-123');
  assert.deepEqual(loaded.declaredFilePath, { logicalPath: 'inputs/shortlist.csv', resolvedPath: join(continuationDir, 'inputs', 'shortlist.csv') });
});
