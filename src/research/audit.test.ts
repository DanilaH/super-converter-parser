import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFailedResearchAudit,
  buildResearchAudit,
  type ResearchAuditCheckId,
} from './audit.js';
import type { ResearchStatusWithHistoricalPresence } from './statusWithHistoricalPresence.js';

const NOW = '2026-09-07T00:00:00.000Z';

function baseStatus(): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'run_audit_fixture',
    label: 'audit-fixture',
    researchDirectory: '/tmp/audit-fixture',
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'run_audit_fixture',
      state: 'completed',
      createdAt: NOW,
      updatedAt: NOW,
      pauseReason: null,
      keywordCounts: {
        total: 2,
        pending: 0,
        running: 0,
        completed: 2,
        partial: 0,
        failed: 0,
        repairable: 0,
      },
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
    library: {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: 'no_current_enrichment',
      lookupError: null,
      derivedSnapshotsCurrent: null,
      derivedSnapshotWarning: null,
    },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: {
      code: 'run_enrichment',
      message: 'No enrichment exists for current discovery.',
      command: null,
    },
  };
}

function check(status: ResearchStatusWithHistoricalPresence, id: ResearchAuditCheckId) {
  const audit = buildResearchAudit(status);
  const result = audit.checks.find((item) => item.id === id);
  assert.ok(result, `missing audit check ${id}`);
  return { audit, result };
}

test('clean completed discovery can pass while downstream checks remain not applicable', () => {
  const audit = buildResearchAudit(baseStatus());
  assert.equal(audit.overall, 'pass');
  assert.equal(audit.checks.find((item) => item.id === 'research_projection')?.status, 'pass');
  assert.equal(audit.checks.find((item) => item.id === 'discovery_completion')?.status, 'pass');
  assert.equal(audit.checks.find((item) => item.id === 'current_enrichment')?.status, 'not_applicable');
  assert.equal(audit.checks.find((item) => item.id === 'library_publication')?.status, 'not_applicable');
});

test('incomplete discovery and run-quality uncertainty are warnings rather than structural failure', () => {
  const status = baseStatus();
  status.discovery = {
    ...status.discovery,
    state: 'completed_with_errors',
    keywordCounts: {
      total: 2,
      pending: 0,
      running: 0,
      completed: 1,
      partial: 0,
      failed: 1,
      repairable: 1,
    },
    qualityWarnings: [{
      code: 'GOOGLE_SERP_INCOMPLETE',
      affected: 1,
      denominator: 2,
      message: '1/2 trustworthy SERPs',
    }],
  };

  const audit = buildResearchAudit(status);
  assert.equal(audit.overall, 'warn');
  assert.equal(audit.checks.find((item) => item.id === 'discovery_completion')?.status, 'warn');
  assert.equal(audit.checks.find((item) => item.id === 'discovery_quality')?.status, 'warn');
  assert.ok(!audit.checks.some((item) => item.status === 'fail'));
});

test('legacy layout warns because modern lineage/downstream coverage is limited', () => {
  const status = baseStatus();
  status.legacy = true;
  const { audit, result } = check(status, 'layout_coverage');
  assert.equal(result.status, 'warn');
  assert.equal(audit.overall, 'warn');
});

test('missing current enrichment projection is a hard audit failure', () => {
  const status = baseStatus();
  status.currentEnrichmentId = 'enrichment_missing';
  const { audit, result } = check(status, 'current_enrichment');
  assert.equal(result.status, 'fail');
  assert.equal(audit.overall, 'fail');
});

test('stale finalist artifact is a hard failure while an unfinished finalization is only warning-level', () => {
  const stale = baseStatus();
  stale.finalization = {
    ...stale.finalization,
    state: 'in_progress',
    enrichmentId: 'enrichment_1',
    artifactWarning: 'finalist evidence matrix is stale relative to current durable parent snapshots',
  };
  assert.equal(check(stale, 'finalization_projection').result.status, 'fail');
  assert.equal(buildResearchAudit(stale).overall, 'fail');

  const unfinished = baseStatus();
  unfinished.finalization = {
    ...unfinished.finalization,
    state: 'in_progress',
    enrichmentId: 'enrichment_1',
  };
  assert.equal(check(unfinished, 'finalization_projection').result.status, 'warn');
  assert.equal(buildResearchAudit(unfinished).overall, 'warn');
});

test('Library derived-snapshot drift stays warning-level because durable Library truth remains authoritative', () => {
  const status = baseStatus();
  status.library = {
    published: true,
    publicationId: 'pub_fixture',
    publishedAt: NOW,
    reason: null,
    lookupError: null,
    derivedSnapshotsCurrent: false,
    derivedSnapshotWarning: 'library.json hash mismatch',
  };
  const { audit, result } = check(status, 'library_publication');
  assert.equal(result.status, 'warn');
  assert.equal(audit.overall, 'warn');
  assert.match(result.message, /durable Library publication exists/i);
});

test('a durable read/projection exception can be represented as an explicit failed audit', () => {
  const audit = buildFailedResearchAudit({
    targetResearchId: 'run_bad_lineage',
    code: 'OUTPUT_WRITE_ERROR',
    message: 'current run does not match latest batch result',
  });
  assert.equal(audit.overall, 'fail');
  assert.equal(audit.checks.length, 1);
  assert.equal(audit.checks[0]?.id, 'research_projection');
  assert.equal(audit.checks[0]?.status, 'fail');
  assert.match(audit.checks[0]?.message ?? '', /OUTPUT_WRITE_ERROR/);
});
