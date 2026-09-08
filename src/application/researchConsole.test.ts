import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan, type LoadedOperatorResearchConfig } from '../operatorConfig/resolve.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { projectConsoleHumanRequirement } from './researchConsole.js';

function status(overrides: Partial<ResearchStatusWithHistoricalPresence> = {}): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'configured',
    researchDirectory: '/tmp/research',
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'run-1',
      state: 'completed',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      pauseReason: null,
      keywordCounts: { total: 2, pending: 0, running: 0, completed: 2, partial: 0, failed: 0, repairable: 0 },
      qualityWarnings: [],
    },
    enrichments: [],
    currentEnrichmentId: null,
    finalization: {
      state: 'not_started',
      enrichmentId: null,
      finalistCount: 0,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: null,
    },
    library: { published: false, publicationId: null, publishedAt: null, reason: 'not_published', lookupError: null },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: { code: 'none', message: 'fixture', command: null },
    ...overrides,
  };
}

function completedEnrichment() {
  return {
    enrichmentId: 'enrich-1',
    generation: 1,
    directoryName: 'enrichment',
    sourceRunId: 'run-1',
    state: 'completed',
    createdAt: 'x',
    updatedAt: 'x',
    modules: ['clusters'],
    itemCounts: {},
    error: null,
    isForCurrentDiscovery: true,
    isLatestForCurrentDiscovery: true,
  };
}

function configured(target: 'enrichment' | 'finalization', modules: Array<'clusters' | 'query_suggestions'> = ['clusters']) {
  const config = {
    version: 1 as const,
    research: { label: 'configured', input: { type: 'seeds' as const, path: 'seeds.csv' } },
    workflow: { target },
    enrichment: { modules },
    ...(target === 'finalization'
      ? { finalization: { historyPolicy: { youngDomainMaxAgeDays: 730, recentWebPresenceMaxAgeDays: 1095, repurposeGapMinDays: 365 } } }
      : {}),
  };
  const loaded = { config, plan: buildNewResearchPlan(config, '/tmp/research.config.json') } as LoadedOperatorResearchConfig;
  return buildPersistedOperatorConfig(loaded);
}

test('console projects shortlist from the canonical unresolved human requirements', () => {
  assert.equal(
    projectConsoleHumanRequirement(status(), configured('enrichment', ['clusters', 'query_suggestions'])),
    'shortlist',
  );
});

test('console projects finalist scope only for the canonical finalist gate', () => {
  const current = status({
    enrichments: [completedEnrichment()],
    currentEnrichmentId: 'enrich-1',
    finalization: {
      state: 'not_started',
      enrichmentId: 'enrich-1',
      finalistCount: 0,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: null,
    },
  });
  assert.equal(projectConsoleHumanRequirement(current, configured('finalization')), 'finalist_scope');
});

test('console projects human decisions from the canonical decision gate', () => {
  const current = status({
    enrichments: [completedEnrichment()],
    currentEnrichmentId: 'enrich-1',
    finalization: {
      state: 'awaiting_decisions',
      enrichmentId: 'enrich-1',
      finalistCount: 2,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: true,
      artifactWarning: null,
    },
  });
  assert.equal(projectConsoleHumanRequirement(current, configured('finalization')), 'human_decisions');
});

test('console does not reinterpret a non-human blocked finalization as finalist scope', () => {
  const current = status({
    enrichments: [completedEnrichment()],
    currentEnrichmentId: 'enrich-1',
    finalization: {
      state: 'in_progress',
      enrichmentId: 'enrich-1',
      finalistCount: 0,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: 'fixture blocked state',
    },
  });
  assert.equal(projectConsoleHumanRequirement(current, configured('finalization')), null);
});
