import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { OperatorResearchConfigV1 } from '../operatorConfig/contracts.js';
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan } from '../operatorConfig/resolve.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { OperatorGuiService, listIndexedRunIds } from './service.js';

function completedStatus(researchId: string, researchDirectory: string, updatedAt: string): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId,
    label: researchId,
    researchDirectory,
    legacy: false,
    discovery: {
      generation: 1,
      runId: researchId,
      state: 'completed',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt,
      pauseReason: null,
      keywordCounts: {
        total: 1,
        pending: 0,
        running: 0,
        completed: 1,
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
    },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: { code: 'run_enrichment', message: 'No enrichment exists.', command: null },
  };
}

function discoveryOnlyProvenance() {
  const config: OperatorResearchConfigV1 = {
    version: 1,
    research: {
      label: 'existing',
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
    workflow: { target: 'discovery' },
  };
  return buildPersistedOperatorConfig({
    config,
    plan: buildNewResearchPlan(config, '/tmp/gui-existing/research.config.json'),
  });
}

test('GUI new-research draft is validated by the production config loader and reused by the production executor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-service-'));
  const outputRoot = join(root, 'output');
  const draftRoot = join(root, 'drafts');
  await mkdir(draftRoot, { recursive: true });
  const executedConfigPaths: string[] = [];

  const service = new OperatorGuiService({
    outputRoot,
    draftRoot,
    env: {} as NodeJS.ProcessEnv,
    deps: {
      runNew: async (configPath) => {
        executedConfigPaths.push(configPath);
        return {
          exitCode: 0,
          result: {
            version: 1,
            exitCode: 0,
            researchId: 'research-1',
            discoveryRunId: 'research-1',
            discoveryState: 'completed',
            enrichmentId: null,
            enrichmentState: null,
            finalizationState: null,
            publicationId: null,
            workflowTarget: 'discovery',
            workflowState: 'completed',
            stopPoint: 'complete',
            unresolvedHumanRequirements: [],
            effectiveConfigFingerprint: 'fingerprint',
            stageFingerprints: {
              discoverySemanticFingerprint: 'd',
              enrichmentSemanticFingerprint: 'e',
              finalizationPolicyFingerprint: 'f',
            },
            operatorConfigPath: '/tmp/operator-config.json',
          },
        };
      },
    },
  });

  const planned = await service.planNew({
    version: 1,
    preset: 'quick-scan',
    research: {
      label: 'gui-new',
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
  }, {
    'input/seeds.csv': 'keyword\njson formatter\n',
  });

  assert.ok(planned.draftId);
  const plan = planned.plan;
  assert.equal(plan.stateContext.kind, 'new');
  if (!('preset' in plan)) assert.fail('new GUI draft must produce a new-research plan');
  assert.deepEqual(plan.preset, { id: 'quick-scan', revision: 1 });
  assert.equal(plan.semantics.research.input.logicalPath, 'input/seeds.csv');
  const resolvedInput = plan.filesystemInputs[0]?.resolvedPath;
  assert.ok(resolvedInput);
  assert.equal((await readFile(resolvedInput, 'utf8')).trim(), 'keyword\njson formatter');

  const execution = await service.runNew(planned.draftId);
  assert.equal(execution.exitCode, 0);
  assert.equal(executedConfigPaths.length, 1);
  assert.equal(executedConfigPaths[0]?.endsWith('research.config.json'), true);

  await service.close();
});

test('GUI uploaded files reject traversal before a production config or continuation is planned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-traversal-'));
  const service = new OperatorGuiService({
    outputRoot: join(root, 'output'),
    draftRoot: join(root, 'drafts'),
  });
  await mkdir(service.draftRoot, { recursive: true });

  await assert.rejects(
    service.planNew({
      version: 1,
      research: { label: 'bad', input: { type: 'seeds', path: '../escape.csv' } },
    }, { '../escape.csv': 'keyword\nx\n' }),
    /without traversal/,
  );

  await service.close();
});

test('existing-research planning uses stable identity and canonical persisted OperatorConfig', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-existing-'));
  const researchDirectory = join(root, 'output', 'research-1');
  const service = new OperatorGuiService({
    outputRoot: join(root, 'output'),
    draftRoot: join(root, 'drafts'),
    deps: {
      buildStatus: async () => completedStatus('research-1', researchDirectory, '2026-09-01T00:00:02.000Z'),
      readProvenance: async () => discoveryOnlyProvenance(),
      runExisting: async (researchId, continuationPath) => {
        assert.equal(researchId, 'research-1');
        assert.equal(continuationPath, null);
        return {
          exitCode: 0,
          result: {
            version: 1,
            exitCode: 0,
            researchId,
            discoveryRunId: researchId,
            discoveryState: 'completed',
            enrichmentId: null,
            enrichmentState: null,
            finalizationState: 'not_started',
            publicationId: null,
            workflowTarget: 'discovery',
            workflowState: 'completed',
            stopPoint: 'complete',
            unresolvedHumanRequirements: [],
            effectiveConfigFingerprint: discoveryOnlyProvenance().effectiveConfigFingerprint,
            stageFingerprints: discoveryOnlyProvenance().stageFingerprints,
            operatorConfigPath: join(researchDirectory, 'operator-config.json'),
          },
        };
      },
    },
  });
  await mkdir(service.draftRoot, { recursive: true });

  const planned = await service.planExisting('research-1', null);
  assert.equal(planned.draftId, null);
  assert.equal(planned.plan.stateContext.kind, 'existing');
  assert.equal(planned.plan.stateContext.researchId, 'research-1');
  assert.equal(planned.plan.stages[0]?.state, 'already_satisfied');

  const execution = await service.runExisting('research-1', null);
  assert.equal(execution.result.researchId, 'research-1');

  await service.close();
});

test('research index enumeration is sorted and research list canonicalizes duplicate run ids through read-only status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-list-'));
  const outputRoot = join(root, 'output');
  const indexDirectory = join(outputRoot, 'index', 'runs');
  await mkdir(indexDirectory, { recursive: true });
  await writeFile(join(indexDirectory, 'run-b.json'), '{}\n', 'utf8');
  await writeFile(join(indexDirectory, 'run-a.json'), '{}\n', 'utf8');
  await writeFile(join(indexDirectory, 'not safe!.json'), '{}\n', 'utf8');

  assert.deepEqual(await listIndexedRunIds(outputRoot), ['run-a', 'run-b']);

  const service = new OperatorGuiService({
    outputRoot,
    draftRoot: join(root, 'drafts'),
    deps: {
      buildStatus: async ({ targetRunId }) => {
        if (targetRunId === 'run-a') return completedStatus('research-shared', join(outputRoot, 'shared'), '2026-09-01T00:00:02.000Z');
        return completedStatus('research-shared', join(outputRoot, 'shared'), '2026-09-01T00:00:03.000Z');
      },
    },
  });
  await mkdir(service.draftRoot, { recursive: true });

  const listed = await service.listResearches();
  assert.equal(listed.errors.length, 0);
  assert.equal(listed.researches.length, 1);
  assert.equal(listed.researches[0]?.researchId, 'research-shared');
  assert.equal(listed.researches[0]?.discovery.updatedAt, '2026-09-01T00:00:03.000Z');

  await service.close();
});

test('GUI bootstrap exposes the production schemas and all built-in preset snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-bootstrap-'));
  const service = await OperatorGuiService.create({
    outputRoot: join(root, 'output'),
    draftRoot: join(root, 'drafts'),
  });

  const bootstrap = await service.bootstrap();
  assert.deepEqual(bootstrap.presets.map((preset) => preset.id), [
    'deep-research',
    'finalist-validation',
    'quick-scan',
    'standard',
  ]);
  assert.equal(bootstrap.schemas.researchConfig.title, 'Utility Research Runner OperatorResearchConfigV1');
  assert.equal(bootstrap.schemas.continuation.title, 'Utility Research Runner OperatorContinuationV1');
  assert.equal(bootstrap.schemas.preset.title, 'Utility Research Runner OperatorResearchPresetV1');

  await service.close();
});
