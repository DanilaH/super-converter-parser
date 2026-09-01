import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan, type LoadedOperatorResearchConfig, type ResolvedOperatorContinuation } from '../operatorConfig/resolve.js';
import { parseResearchPlanArgs, runResearchPlanCli, type ResearchPlanDeps } from './researchPlan.js';
import { ResearchError } from '../shared/errors.js';

function newLoaded(): LoadedOperatorResearchConfig {
  const config = { version: 1 as const, research: { label: 'json', input: { type: 'seeds' as const, path: 'seeds.csv' } } };
  return { config, plan: buildNewResearchPlan(config, '/tmp/research.config.json') };
}

function enrichmentLoaded(): LoadedOperatorResearchConfig {
  const config = {
    version: 1 as const,
    research: { label: 'json', input: { type: 'seeds' as const, path: 'seeds.csv' } },
    workflow: { target: 'enrichment' as const },
    enrichment: { modules: ['clusters' as const] },
  };
  return { config, plan: buildNewResearchPlan(config, '/tmp/research.config.json') };
}

function existingStatus(): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0', researchId: 'research-1', label: 'legacy', researchDirectory: '/tmp/research', legacy: false,
    discovery: { generation: 1, runId: 'run-1', state: 'completed', createdAt: 'x', updatedAt: 'x', pauseReason: null, keywordCounts: { total: 1, pending: 0, running: 0, completed: 1, partial: 0, failed: 0, repairable: 0 }, qualityWarnings: [] },
    enrichments: [], currentEnrichmentId: null,
    finalization: { state: 'not_started', enrichmentId: null, finalistCount: 0, currentDecisionCount: 0, allFinalistsHaveCurrentDecisions: false, finalistMatrixPublished: false, artifactWarning: null },
    library: { published: false, publicationId: null, publishedAt: null, reason: 'none', lookupError: null }, evidenceCoverage: null, sampledHistoricalPresence: null,
    nextAction: { code: 'run_enrichment', message: 'Run enrichment.', command: null },
  };
}

test('planner args require exactly one target and continuation only with research', () => {
  assert.throws(() => parseResearchPlanArgs([]), /exactly one/);
  assert.throws(() => parseResearchPlanArgs(['--config', 'a.json', '--research', 'r']), /exactly one/);
  assert.throws(() => parseResearchPlanArgs(['--config', 'a.json', '--continue', 'c.json']), /--continue is only valid/);
  assert.equal(parseResearchPlanArgs(['--research', 'r', '--json']).json, true);
});

test('new research planner only loads config and returns deterministic JSON', async () => {
  let statusCalls = 0; let continuationCalls = 0; let provenanceCalls = 0;
  const deps: ResearchPlanDeps = {
    loadConfig: async () => newLoaded(),
    loadContinuation: async () => { continuationCalls += 1; throw new Error('unexpected'); },
    loadProvenance: async () => { provenanceCalls += 1; throw new Error('unexpected'); },
    buildStatus: async () => { statusCalls += 1; throw new Error('unexpected'); },
  };
  const a = await runResearchPlanCli(['--config', 'research.json', '--json'], deps, {});
  const b = await runResearchPlanCli(['--config', 'research.json', '--json'], deps, {});
  assert.equal(a.exitCode, 0); assert.equal(a.stdout, b.stdout); assert.equal(statusCalls, 0); assert.equal(continuationCalls, 0); assert.equal(provenanceCalls, 0);
  assert.equal(JSON.parse(a.stdout).stateContext.kind, 'new');
});

test('existing research planner uses read-only status dependency and validates continuation target', async () => {
  let configCalls = 0; let statusCalls = 0; let provenanceCalls = 0;
  const continuation: ResolvedOperatorContinuation = { continuation: { version: 1, researchId: 'wrong', action: { type: 'shortlist', path: 'shortlist.csv' } }, continuationPath: '/tmp/c.json', declaredFilePath: { logicalPath: 'shortlist.csv', resolvedPath: '/tmp/shortlist.csv' } };
  const deps: ResearchPlanDeps = {
    loadConfig: async () => { configCalls += 1; return newLoaded(); },
    loadContinuation: async () => continuation,
    loadProvenance: async () => { provenanceCalls += 1; return null; },
    buildStatus: async () => { statusCalls += 1; return existingStatus(); },
  };
  const result = await runResearchPlanCli(['--research', 'research-1', '--continue', 'c.json'], deps, { RESEARCH_OUTPUT_ROOT: '/tmp/out' });
  assert.equal(result.exitCode, 2); assert.match(result.stderr, /targets research "wrong"/); assert.equal(configCalls, 0); assert.equal(statusCalls, 1); assert.equal(provenanceCalls, 1);
});

test('existing config-first research planner reloads immutable provenance and exposes configured enrichment readiness', async () => {
  const persisted = buildPersistedOperatorConfig(enrichmentLoaded());
  const deps: ResearchPlanDeps = {
    loadConfig: async () => { throw new Error('unexpected'); },
    loadContinuation: async () => { throw new Error('unexpected'); },
    loadProvenance: async (researchDirectory) => {
      assert.equal(researchDirectory, '/tmp/research');
      return persisted;
    },
    buildStatus: async () => existingStatus(),
  };
  const result = await runResearchPlanCli(['--research', 'research-1', '--json'], deps, { RESEARCH_OUTPUT_ROOT: '/tmp/out' });
  assert.equal(result.exitCode, 0);
  const plan = JSON.parse(result.stdout) as {
    configAvailability: string;
    effectiveConfigFingerprint: string | null;
    stages: Array<{ id: string; state: string }>;
    unresolvedHumanRequirements: string[];
    expectedStopPoint: string;
  };
  assert.equal(plan.configAvailability, 'operator_config');
  assert.equal(plan.effectiveConfigFingerprint, persisted.effectiveConfigFingerprint);
  assert.deepEqual(plan.stages.map((stage) => [stage.id, stage.state]), [['discovery', 'already_satisfied'], ['enrichment', 'ready'], ['finalization', 'not_requested']]);
  assert.deepEqual(plan.unresolvedHumanRequirements, []);
  assert.equal(plan.expectedStopPoint, 'enrichment');
});

test('planner maps schema errors to stable invalid-input exit code', async () => {
  const deps: ResearchPlanDeps = {
    loadConfig: async () => { throw new ResearchError('INPUT_SCHEMA_ERROR', 'bad config'); },
    loadContinuation: async () => { throw new Error('unexpected'); },
    loadProvenance: async () => { throw new Error('unexpected'); },
    buildStatus: async () => { throw new Error('unexpected'); },
  };
  const result = await runResearchPlanCli(['--config', 'bad.json'], deps, {});
  assert.equal(result.exitCode, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /INPUT_SCHEMA_ERROR: bad config/);
});
