import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ResearchRunExecution } from '../application/researchWorkflow.js';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { outputLayout } from '../outputs/researchLayout.js';
import { previewUiResearchDraft } from './researchExecution.js';
import { startUiServer, type UiServerDeps } from './server.js';

const root = resolve('/tmp/runner-ui-live-id-output');
const diagnostics: OutputDiagnostics = {
  version: 1,
  canonicalRoot: root,
  configuredBy: 'home_default',
  layout: outputLayout(root),
  overrideEscapeHatchEnabled: false,
  rootExists: true,
  researchesDirectoryExists: true,
  repoLocalLegacyDirectories: [],
};

const execution: ResearchRunExecution = {
  exitCode: 0,
  result: {
    version: 1,
    exitCode: 0,
    researchId: 'research-live',
    discoveryRunId: 'research-live',
    discoveryState: 'completed',
    enrichmentId: null,
    enrichmentState: null,
    finalizationState: null,
    publicationId: null,
    workflowTarget: 'discovery',
    workflowState: 'completed',
    stopPoint: 'complete',
    unresolvedHumanRequirements: [],
    effectiveConfigFingerprint: 'config',
    stageFingerprints: {
      discoverySemanticFingerprint: 'discovery',
      enrichmentSemanticFingerprint: 'enrichment',
      finalizationPolicyFingerprint: 'finalization',
    },
    operatorConfigPath: '/output/operator-config.json',
  },
};

const draft = {
  version: 1,
  label: 'Live identity test',
  preset: 'quick-scan',
  keywords: 'alpha\nbeta',
};

test('create endpoint exposes durable researchId while the UI job is still running', async () => {
  let finish: (value: ResearchRunExecution) => void = () => {
    throw new Error('Deferred execution resolver was not initialized.');
  };
  const pending = new Promise<ResearchRunExecution>((resolvePromise) => { finish = resolvePromise; });

  const deps: UiServerDeps = {
    buildOutputDiagnostics: async () => diagnostics,
    listResearchCatalog: async () => [],
    inspectResearchConsole: async () => { throw new Error('detail not expected'); },
    previewUiResearchDraft,
    executeUiResearchDraft: async (_value, options) => {
      await options?.onResearchInitialized?.({
        researchId: 'research-live',
        researchDirectory: '/output/research-live',
        discoveryDirectory: '/output/research-live/discovery',
      });
      return pending;
    },
    executeUiResearchResume: async () => execution,
    loadStaticAssets: async () => new Map([
      ['/index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from('shell') }],
    ]),
    openBrowser: () => undefined,
  };

  const started = await startUiServer({ port: 0, openBrowser: false, env: {}, deps });
  try {
    const response = await fetch(`${started.url}/api/researches`, {
      method: 'POST',
      headers: {
        Origin: started.url,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(draft),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json() as { job: { jobId: string } };

    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const jobsResponse = await fetch(`${started.url}/api/jobs/${accepted.job.jobId}`);
    const payload = await jobsResponse.json() as { job: { state: string; researchId: string | null } };
    assert.equal(payload.job.state, 'running');
    assert.equal(payload.job.researchId, 'research-live');

    finish(execution);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  } finally {
    await started.close();
  }
});
