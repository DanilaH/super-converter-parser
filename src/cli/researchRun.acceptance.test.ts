import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseFinalistDecisionsJson } from '../enrichment/finalistDecisionConfig.js';
import type { ConfiguredFinalizationResult } from '../finalization/configuredRun.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  runResearchFromConfig,
  runResearchFromExisting,
  type ResearchRunDeps,
} from './researchRun.js';
import { runResearchPlanCli } from './researchPlan.js';

type Phase = 'discovery' | 'enriched' | 'awaiting_decisions' | 'published';

function statusForPhase(researchDirectory: string, phase: Phase): ResearchStatusWithHistoricalPresence {
  const enriched = phase !== 'discovery';
  const awaitingDecisions = phase === 'awaiting_decisions';
  const published = phase === 'published';
  return {
    version: '1.2.0',
    researchId: 'research-acceptance',
    label: 'config-first-acceptance',
    researchDirectory,
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'research-acceptance',
      state: 'completed',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
      pauseReason: null,
      keywordCounts: {
        total: 3,
        pending: 0,
        running: 0,
        completed: 3,
        partial: 0,
        failed: 0,
        repairable: 0,
      },
      qualityWarnings: [],
    },
    enrichments: enriched ? [{
      enrichmentId: 'enrichment-acceptance',
      generation: 1,
      directoryName: 'enrichment',
      sourceRunId: 'research-acceptance',
      state: 'completed',
      createdAt: '2026-09-01T00:00:02.000Z',
      updatedAt: '2026-09-01T00:00:03.000Z',
      modules: ['clusters'],
      itemCounts: {},
      error: null,
      isForCurrentDiscovery: true,
      isLatestForCurrentDiscovery: true,
    }] : [],
    currentEnrichmentId: enriched ? 'enrichment-acceptance' : null,
    finalization: {
      state: published ? 'published' : awaitingDecisions ? 'awaiting_decisions' : 'not_started',
      enrichmentId: enriched ? 'enrichment-acceptance' : null,
      finalistCount: awaitingDecisions || published ? 1 : 0,
      currentDecisionCount: published ? 1 : 0,
      allFinalistsHaveCurrentDecisions: published,
      finalistMatrixPublished: awaitingDecisions || published,
      artifactWarning: null,
    },
    library: {
      published,
      publicationId: published ? 'publication-acceptance' : null,
      publishedAt: published ? '2026-09-01T00:00:04.000Z' : null,
      reason: published ? 'all_decisions_current' : null,
      lookupError: null,
    },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: published
      ? { code: 'none', message: 'Research complete.', command: null }
      : awaitingDecisions
        ? { code: 'supply_decisions', message: 'Supply human decisions.', command: null }
        : enriched
          ? { code: 'run_finalization', message: 'Select finalist scope.', command: null }
          : { code: 'run_enrichment', message: 'Run enrichment.', command: null },
  };
}

function publishedFinalizationResult(): ConfiguredFinalizationResult {
  return {
    outcome: { kind: 'published', state: 'published', publicationId: 'publication-acceptance' },
    fullRun: null,
    traffic: null,
    finalistEvidence: {
      enrichmentId: 'enrichment-acceptance',
      sourceRunId: 'research-acceptance',
      representativeRevision: 1,
      entrantFingerprint: 'entrant-fingerprint',
      finalistCount: 1,
      cohortHistoryAvailableCount: 1,
      sampledHistoryCollectedCount: 1,
      importedTrafficSnapshotCount: 0,
      currentHumanDecisionCount: 1,
      staleHumanDecisionCount: 0,
      unrecordedHumanDecisionCount: 0,
      auditFlagCount: 0,
      csvPath: '/tmp/finalist-evidence.csv',
      jsonPath: '/tmp/finalist-evidence.json',
    },
    publication: null,
  };
}

test('config-first operator lifecycle plans first, preserves stable identity, stops at human gates, and completes only after explicit decisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'config-first-acceptance-'));
  const outputRoot = join(root, 'output');
  const configDirectory = join(root, 'config');
  const researchDirectory = join(outputRoot, 'research-acceptance');
  const discoveryDirectory = join(researchDirectory, 'discovery');
  await mkdir(join(configDirectory, 'input'), { recursive: true });
  await mkdir(discoveryDirectory, { recursive: true });
  await writeFile(join(configDirectory, 'input', 'seeds.csv'), 'keyword\njson formatter\nfavicon generator\nimage compressor\n', 'utf8');
  const configPath = join(configDirectory, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    preset: 'finalist-validation',
    research: {
      label: 'config-first-acceptance',
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
  }), 'utf8');

  const dryRun = await runResearchPlanCli(['--config', configPath, '--json']);
  assert.equal(dryRun.exitCode, 0);
  const dryPlan = JSON.parse(dryRun.stdout) as {
    stateContext: { kind: string };
    preset: { id: string; revision: number } | null;
    stages: Array<{ id: string; state: string }>;
    expectedStopPoint: string;
  };
  assert.equal(dryPlan.stateContext.kind, 'new');
  assert.deepEqual(dryPlan.preset, { id: 'finalist-validation', revision: 1 });
  assert.deepEqual(dryPlan.stages.map((stage) => [stage.id, stage.state]), [
    ['discovery', 'ready'],
    ['enrichment', 'blocked'],
    ['finalization', 'blocked'],
  ]);
  assert.equal(dryPlan.expectedStopPoint, 'discovery');

  let phase: Phase = 'discovery';
  let enrichmentRuns = 0;
  const finalizationActions: Array<string | null> = [];
  const deps: ResearchRunDeps = {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    acquireExecutionLock: async () => async () => undefined,
    buildStatus: async () => statusForPhase(researchDirectory, phase),
    runDiscovery: async (request) => {
      await request.onFreshResearchInitialized?.({
        runId: 'research-acceptance',
        researchDirectory,
        discoveryDirectory,
      });
      return {
        exitCode: 0,
        researchId: 'research-acceptance',
        runId: 'research-acceptance',
        researchDirectory,
        discoveryDirectory,
        state: 'completed',
      };
    },
    runConfiguredEnrichment: async (request) => {
      enrichmentRuns += 1;
      assert.equal(request.researchId, 'research-acceptance');
      assert.equal(request.sourceRunId, 'research-acceptance');
      assert.equal(request.currentEnrichmentId, null);
      phase = 'enriched';
      return {
        outcome: { kind: 'completed', enrichmentId: 'enrichment-acceptance', state: 'completed', result: {} },
        enrichmentId: 'enrichment-acceptance',
        enrichmentDirectory: join(researchDirectory, 'enrichment'),
        resumed: false,
        archivePath: null,
      };
    },
    runConfiguredFinalization: async (request) => {
      const action = request.continuation?.continuation.action.type ?? null;
      finalizationActions.push(action);
      assert.equal(request.researchId, 'research-acceptance');
      assert.equal(request.enrichmentId, 'enrichment-acceptance');
      if (action === 'finalists') {
        phase = 'awaiting_decisions';
        return {
          outcome: { kind: 'awaiting_decisions', state: 'awaiting_decisions', finalistCount: 1, currentDecisionCount: 0 },
          fullRun: null,
          traffic: null,
          finalistEvidence: null,
          publication: null,
        };
      }
      if (action === 'decisions') {
        assert.equal(request.continuation?.declaredFilePath?.resolvedPath, join(configDirectory, 'decisions.json'));
        phase = 'published';
        return publishedFinalizationResult();
      }
      throw new Error(`unexpected finalization action: ${action ?? 'none'}`);
    },
  };

  const initial = await runResearchFromConfig(configPath, outputRoot, deps, {} as NodeJS.ProcessEnv);
  assert.equal(initial.exitCode, 0);
  assert.equal(initial.result.researchId, 'research-acceptance');
  assert.equal(initial.result.discoveryRunId, 'research-acceptance');
  assert.equal(initial.result.enrichmentId, 'enrichment-acceptance');
  assert.equal(initial.result.workflowState, 'awaiting_finalist_scope');
  assert.deepEqual(initial.result.unresolvedHumanRequirements, ['finalist_scope']);
  assert.equal(enrichmentRuns, 1);
  assert.deepEqual(finalizationActions, []);

  const provenanceText = await readFile(join(researchDirectory, 'operator-config.json'), 'utf8');
  assert.match(provenanceText, /"preset"/);
  assert.match(provenanceText, /"finalist-validation"/);

  const finalistsPath = join(configDirectory, 'finalists.json');
  await writeFile(finalistsPath, JSON.stringify({
    version: 1,
    researchId: 'research-acceptance',
    action: { type: 'finalists', clusters: ['cluster-1'] },
  }), 'utf8');
  const finalistsText = await readFile(finalistsPath, 'utf8');
  assert.equal(finalistsText.includes('enrichment-acceptance'), false);
  assert.equal(finalistsText.includes('enrichmentId'), false);

  const afterFinalists = await runResearchFromExisting(
    'research-acceptance',
    finalistsPath,
    outputRoot,
    deps,
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(afterFinalists.exitCode, 0);
  assert.equal(afterFinalists.result.researchId, 'research-acceptance');
  assert.equal(afterFinalists.result.workflowState, 'awaiting_decisions');
  assert.deepEqual(afterFinalists.result.unresolvedHumanRequirements, ['human_decisions']);
  assert.deepEqual(finalizationActions, ['finalists']);

  const withoutDecision = await runResearchFromExisting(
    'research-acceptance',
    null,
    outputRoot,
    deps,
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(withoutDecision.exitCode, 0);
  assert.equal(withoutDecision.result.workflowState, 'awaiting_decisions');
  assert.deepEqual(withoutDecision.result.unresolvedHumanRequirements, ['human_decisions']);
  assert.deepEqual(finalizationActions, ['finalists']);

  const decisionsPath = join(configDirectory, 'decisions.json');
  await writeFile(decisionsPath, JSON.stringify([
    {
      clusterId: 'cluster-1',
      buildDecision: 'watch',
      seoProductRole: 'experimental',
    },
  ]), 'utf8');
  const parsedDecisions = parseFinalistDecisionsJson(await readFile(decisionsPath, 'utf8'));
  assert.deepEqual(parsedDecisions, [{
    clusterId: 'cluster-1',
    buildDecision: 'watch',
    seoProductRole: 'experimental',
  }]);

  const decisionsContinuationPath = join(configDirectory, 'decisions-continuation.json');
  await writeFile(decisionsContinuationPath, JSON.stringify({
    version: 1,
    researchId: 'research-acceptance',
    action: { type: 'decisions', path: 'decisions.json' },
  }), 'utf8');

  const completed = await runResearchFromExisting(
    'research-acceptance',
    decisionsContinuationPath,
    outputRoot,
    deps,
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.result.researchId, 'research-acceptance');
  assert.equal(completed.result.workflowState, 'completed');
  assert.equal(completed.result.stopPoint, 'complete');
  assert.equal(completed.result.finalizationState, 'published');
  assert.equal(completed.result.publicationId, 'publication-acceptance');
  assert.deepEqual(completed.result.unresolvedHumanRequirements, []);
  assert.deepEqual(finalizationActions, ['finalists', 'decisions']);
});
