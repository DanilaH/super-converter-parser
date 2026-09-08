import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ResearchBatchExecutionResultV1 } from '../application/researchBatches.js';
import type { OutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { outputLayout } from '../outputs/researchLayout.js';
import type { UiBatchPlanPreviewV1 } from './batchExecution.js';
import { DEFAULT_UI_SERVER_DEPS, startUiServer, type UiServerDeps } from './server.js';

const root = resolve('/tmp/runner-ui-batch-output');
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

const draft = { version: 1, keywords: 'alpha\nbeta' };
const plan: UiBatchPlanPreviewV1 = {
  version: 1,
  researchId: 'research-1',
  currentRunId: 'run-1',
  batchId: 'batch-0002',
  inputLineCount: 2,
  inputUniqueKeywordCount: 2,
  addedKeywordCount: 1,
  duplicateKeywordCount: 1,
  promotedKeywordCount: 0,
  promotedNormalizedKeywords: [],
  changed: true,
};
const result: ResearchBatchExecutionResultV1 = {
  version: 1,
  researchId: 'research-1',
  researchDirectory: '/output/research-1',
  batchId: 'batch-0002',
  previousRunId: 'run-1',
  currentRunId: 'run-2',
  inputUniqueKeywordCount: 2,
  addedKeywordCount: 1,
  duplicateKeywordCount: 1,
  promotedKeywordCount: 0,
  promotedNormalizedKeywords: [],
  changed: true,
  discovery: { attempted: true, exitCode: 0, state: 'completed' },
  archiveWarning: null,
};

function deps(overrides: Partial<UiServerDeps> = {}): UiServerDeps {
  return {
    ...DEFAULT_UI_SERVER_DEPS,
    buildOutputDiagnostics: async () => diagnostics,
    loadStaticAssets: async () => new Map([
      ['/index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from('shell') }],
    ]),
    openBrowser: () => undefined,
    previewUiResearchBatch: async () => plan,
    executeUiResearchBatch: async () => result,
    ...overrides,
  };
}

function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('batch preview is read-only and does not start a UI job', async () => {
  let executions = 0;
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ executeUiResearchBatch: async () => { executions += 1; return result; } }),
  });
  try {
    const response = await post(started.url, '/api/researches/run-old/batches/plan', draft);
    assert.equal(response.status, 200);
    const payload = await response.json() as { plan: UiBatchPlanPreviewV1 };
    assert.equal(payload.plan.researchId, 'research-1');
    assert.equal(payload.plan.batchId, 'batch-0002');
    assert.equal(executions, 0);
    const jobs = await fetch(`${started.url}/api/jobs`).then((value) => value.json()) as { jobs: unknown[] };
    assert.deepEqual(jobs.jobs, []);
  } finally {
    await started.close();
  }
});

test('batch commit re-previews then starts a distinct append_batch job against the stable research id', async () => {
  const sequence: string[] = [];
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({
      previewUiResearchBatch: async (researchId) => {
        sequence.push(`preview:${researchId}`);
        return plan;
      },
      executeUiResearchBatch: async (researchId) => {
        sequence.push(`execute:${researchId}`);
        return result;
      },
    }),
  });
  try {
    const response = await post(started.url, '/api/researches/run-old/batches', draft);
    assert.equal(response.status, 202);
    const accepted = await response.json() as { job: { jobId: string; kind: string; researchId: string }; plan: UiBatchPlanPreviewV1 };
    assert.equal(accepted.job.kind, 'append_batch');
    assert.equal(accepted.job.researchId, 'research-1');
    assert.equal(accepted.plan.researchId, 'research-1');

    const job = await waitForFinishedJob(started.url, accepted.job.jobId);
    assert.equal(job.state, 'finished');
    assert.equal(job.result, null);
    assert.equal(job.repairResult, null);
    assert.equal(job.batchResult?.batchId, 'batch-0002');
    assert.deepEqual(sequence, ['preview:run-old', 'execute:research-1']);
  } finally {
    await started.close();
  }
});

test('batch commit shares the single-active-job admission boundary', async () => {
  let finish: (value: ResearchBatchExecutionResultV1) => void = () => {
    throw new Error('Deferred batch resolver was not initialized.');
  };
  const pending = new Promise<ResearchBatchExecutionResultV1>((resolvePromise) => { finish = resolvePromise; });
  const started = await startUiServer({
    port: 0,
    openBrowser: false,
    env: {},
    deps: deps({ executeUiResearchBatch: async () => pending }),
  });
  try {
    const first = await post(started.url, '/api/researches/research-1/batches', draft);
    assert.equal(first.status, 202);
    const second = await post(started.url, '/api/researches/research-1/batches', draft);
    assert.equal(second.status, 409);
    const payload = await second.json() as { error: { code: string } };
    assert.equal(payload.error.code, 'UI_JOB_BUSY');
  } finally {
    finish(result);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    await started.close();
  }
});

async function waitForFinishedJob(
  url: string,
  jobId: string,
): Promise<{ state: string; result: unknown; repairResult: unknown; batchResult: ResearchBatchExecutionResultV1 | null }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${url}/api/jobs/${encodeURIComponent(jobId)}`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { job: { state: string; result: unknown; repairResult: unknown; batchResult: ResearchBatchExecutionResultV1 | null } };
    if (payload.job.state !== 'running') return payload.job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Job ${jobId} did not finish in time.`);
}
