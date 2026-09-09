import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveOperatorResearchConfigInput } from '../application/operatorInputs.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  type ResearchRunExecution,
} from '../application/researchWorkflow.js';
import {
  executeUiResearchDraft,
  executeUiResearchResume,
  previewUiResearchDraft,
  validateUiCreateResearchDraft,
  type UiResearchExecutionDeps,
} from './researchExecution.js';

const EXECUTION: ResearchRunExecution = {
  exitCode: 0,
  result: {
    version: 1,
    exitCode: 0,
    researchId: 'research-1',
    discoveryRunId: 'run-1',
    discoveryState: 'completed',
    enrichmentId: null,
    enrichmentState: null,
    finalizationState: null,
    publicationId: null,
    workflowTarget: 'enrichment',
    workflowState: 'completed',
    stopPoint: 'complete',
    unresolvedHumanRequirements: [],
    effectiveConfigFingerprint: 'config',
    stageFingerprints: {
      discoverySemanticFingerprint: 'discovery',
      enrichmentSemanticFingerprint: 'enrichment',
      finalizationPolicyFingerprint: 'finalization',
    },
    operatorConfigPath: null,
  },
};

const DRAFT = {
  version: 1,
  label: 'UI tools',
  preset: 'standard',
  keywords: 'alpha tool\nbeta, tool\nalpha   tool\n',
  market: 'US',
  googleHl: 'en',
  googleGl: 'us',
} as const;

test('preview validates through the real OperatorConfig resolver and reports discovery-normalized keyword counts', async () => {
  const preview = await previewUiResearchDraft(DRAFT);
  assert.equal(preview.inputLineCount, 3);
  assert.equal(preview.uniqueKeywordCount, 2);
  assert.deepEqual(preview.preset, { id: 'standard', revision: 1 });
  assert.equal(preview.workflowTarget, 'enrichment');
  assert.deepEqual(preview.semantics.enrichmentModules, ['clusters']);
  assert.equal(preview.semantics.discovery.expand, true);
  assert.equal(preview.unresolvedHumanRequirements.length, 0);
  assert.ok(!JSON.stringify(preview).includes('runner-ui-preview'));
});

test('draft execution starts Research Chrome before materializing a temporary valid seed CSV', async () => {
  let observedCsv = '';
  let observedSignals: boolean | undefined;
  const sequence: string[] = [];
  const deps: UiResearchExecutionDeps = {
    resolveOperatorResearchConfigInput,
    ensureResearchChromeForDiscovery: async () => {
      sequence.push('chrome');
      return {
        version: 1,
        endpoint: 'http://127.0.0.1:9333',
        connected: true,
        browser: 'Chrome/140',
        profileRoot: 'C:\\tmp\\research-profile',
        profileReady: true,
        controlSupported: true,
        controlReason: null,
        configurationError: null,
      };
    },
    executeNewResearch: async (loaded, options) => {
      sequence.push('execute');
      observedCsv = await readFile(loaded.plan.semantics.research.input.resolvedPath, 'utf8');
      observedSignals = options?.manageProcessSignals;
      return EXECUTION;
    },
    executeExistingResearch: async () => EXECUTION,
  };

  const result = await executeUiResearchDraft(DRAFT, { env: {}, outputRoot: '/tmp/output' }, deps);
  assert.equal(result, EXECUTION);
  assert.equal(observedSignals, false);
  assert.equal(observedCsv, 'keyword\n"alpha tool"\n"beta, tool"\n"alpha   tool"\n');
  assert.deepEqual(sequence, ['chrome', 'execute']);
});

test('live initialization chains after the existing fresh-research callback instead of replacing it', async () => {
  const events: string[] = [];
  let initializedId = '';
  const baseDeps = {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    runDiscovery: async (request: Parameters<typeof DEFAULT_RESEARCH_RUN_DEPS.runDiscovery>[0]) => {
      await request.onFreshResearchInitialized?.({
        runId: 'research-live',
        researchDirectory: '/output/research-live',
        discoveryDirectory: '/output/research-live/discovery',
      });
      return {
        exitCode: 0,
        researchId: 'research-live',
        runId: 'research-live',
        researchDirectory: '/output/research-live',
        discoveryDirectory: '/output/research-live/discovery',
        state: 'completed',
      };
    },
  };
  const deps: UiResearchExecutionDeps = {
    resolveOperatorResearchConfigInput,
    executeNewResearch: async (_loaded, options) => {
      assert.ok(options?.deps);
      await options.deps.runDiscovery(
        {
          input: { kind: 'seeds', path: '/tmp/seeds.csv' },
          onFreshResearchInitialized: async () => { events.push('provenance'); },
        },
        options.deps.cliDeps,
        {},
      );
      return EXECUTION;
    },
    executeExistingResearch: async () => EXECUTION,
  };

  await executeUiResearchDraft(
    DRAFT,
    {
      env: {},
      outputRoot: '/tmp/output',
      deps: baseDeps,
      onResearchInitialized: ({ researchId }) => {
        initializedId = researchId;
        events.push('ui');
      },
    },
    deps,
  );

  assert.equal(initializedId, 'research-live');
  assert.deepEqual(events, ['provenance', 'ui']);
});

test('resume uses the same application workflow with process-level signal ownership disabled', async () => {
  let observedId = '';
  let observedSignals: boolean | undefined;
  const result = await executeUiResearchResume(
    ' research-1 ',
    { env: {}, outputRoot: '/tmp/output' },
    {
      executeExistingResearch: async (researchId, continuation, options) => {
        observedId = researchId;
        observedSignals = options?.manageProcessSignals;
        assert.equal(continuation, null);
        return EXECUTION;
      },
    },
  );

  assert.equal(result, EXECUTION);
  assert.equal(observedId, 'research-1');
  assert.equal(observedSignals, false);
});

test('UI draft rejects unknown fields instead of silently inventing configuration semantics', () => {
  assert.throws(
    () => validateUiCreateResearchDraft({ ...DRAFT, mystery: true }),
    /Unknown UI research draft field: mystery/,
  );
});
