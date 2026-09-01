import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { buildNewResearchPlan, type LoadedOperatorResearchConfig, type ResolvedOperatorContinuation } from '../operatorConfig/resolve.js';
import { parseResearchPlanArgs, runResearchPlanCli, type ResearchPlanDeps } from './researchPlan.js';
import { ResearchError } from '../shared/errors.js';

function newLoaded(): LoadedOperatorResearchConfig {
  const config = { version: 1 as const, research: { label: 'json', input: { type: 'seeds' as const, path: 'seeds.csv' } } };
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
  let statusCalls = 0; let continuationCalls = 0;
  const deps: ResearchPlanDeps = {
    loadConfig: async () => newLoaded(),
    loadContinuation: async () => { continuationCalls += 1; throw new Error('unexpected'); },
    buildStatus: async () => { statusCalls += 1; throw new Error('unexpected'); },
  };
  const a = await runResearchPlanCli(['--config', 'research.json', '--json'], deps, {});
  const b = await runResearchPlanCli(['--config', 'research.json', '--json'], deps, {});
  assert.equal(a.exitCode, 0); assert.equal(a.stdout, b.stdout); assert.equal(statusCalls, 0); assert.equal(continuationCalls, 0);
  assert.equal(JSON.parse(a.stdout).stateContext.kind, 'new');
});

test('existing research planner uses read-only status dependency and validates continuation target', async () => {
  let configCalls = 0; let statusCalls = 0;
  const continuation: ResolvedOperatorContinuation = { continuation: { version: 1, researchId: 'wrong', action: { type: 'shortlist', path: 'shortlist.csv' } }, continuationPath: '/tmp/c.json', declaredFilePath: { logicalPath: 'shortlist.csv', resolvedPath: '/tmp/shortlist.csv' } };
  const deps: ResearchPlanDeps = {
    loadConfig: async () => { configCalls += 1; return newLoaded(); },
    loadContinuation: async () => continuation,
    buildStatus: async () => { statusCalls += 1; return existingStatus(); },
  };
  const result = await runResearchPlanCli(['--research', 'research-1', '--continue', 'c.json'], deps, { RESEARCH_OUTPUT_ROOT: '/tmp/out' });
  assert.equal(result.exitCode, 2); assert.match(result.stderr, /targets research "wrong"/); assert.equal(configCalls, 0); assert.equal(statusCalls, 1);
});

test('planner maps schema errors to stable invalid-input exit code', async () => {
  const deps: ResearchPlanDeps = {
    loadConfig: async () => { throw new ResearchError('INPUT_SCHEMA_ERROR', 'bad config'); },
    loadContinuation: async () => { throw new Error('unexpected'); },
    buildStatus: async () => { throw new Error('unexpected'); },
  };
  const result = await runResearchPlanCli(['--config', 'bad.json'], deps, {});
  assert.equal(result.exitCode, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /INPUT_SCHEMA_ERROR: bad config/);
});
