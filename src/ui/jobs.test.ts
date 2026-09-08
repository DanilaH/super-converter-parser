import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchRunExecution } from '../application/researchWorkflow.js';
import { ResearchError } from '../shared/errors.js';
import { UiJobBusyError, UiJobRegistry } from './jobs.js';

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
    operatorConfigPath: null,
  },
};

test('job registry exposes running work, blocks a second execution, then publishes the result', async () => {
  let resolveTask: (value: ResearchRunExecution) => void = () => {
    throw new Error('Deferred task resolver was not initialized.');
  };
  const task = new Promise<ResearchRunExecution>((resolve) => { resolveTask = resolve; });
  let tick = 0;
  const registry = new UiJobRegistry({
    createId: () => 'job-1',
    now: () => new Date(Date.UTC(2026, 8, 8, 10, 0, tick++)),
  });

  const started = registry.start('create_research', null, () => task);
  assert.equal(started.state, 'running');
  assert.equal(registry.active()?.jobId, 'job-1');
  assert.throws(
    () => registry.start('resume_research', 'research-2', async () => EXECUTION),
    UiJobBusyError,
  );

  resolveTask(EXECUTION);
  await flushPromises();

  const finished = registry.get('job-1');
  assert.equal(finished?.state, 'finished');
  assert.equal(finished?.researchId, 'research-1');
  assert.equal(finished?.result?.workflowState, 'completed');
  assert.equal(registry.active(), null);
});

test('running create job can publish its durable research id before workflow completion', async () => {
  let resolveTask: (value: ResearchRunExecution) => void = () => {
    throw new Error('Deferred task resolver was not initialized.');
  };
  const task = new Promise<ResearchRunExecution>((resolve) => { resolveTask = resolve; });
  let initialized = false;
  const registry = new UiJobRegistry({
    createId: () => 'job-live',
    now: () => new Date('2026-09-08T10:00:00.000Z'),
  });

  registry.start('create_research', null, async (control) => {
    control.setResearchId(' research-live ');
    initialized = true;
    return task;
  });
  await flushPromises();

  assert.equal(initialized, true);
  const running = registry.get('job-live');
  assert.equal(running?.state, 'running');
  assert.equal(running?.researchId, 'research-live');
  assert.equal(running?.result, null);

  resolveTask(EXECUTION);
  await flushPromises();
  assert.equal(registry.get('job-live')?.state, 'finished');
});

test('resolved non-zero workflow execution is a finished job, not a fabricated job failure', async () => {
  const blocked: ResearchRunExecution = {
    exitCode: 2,
    result: {
      ...EXECUTION.result,
      exitCode: 2,
      workflowState: 'blocked',
      stopPoint: 'discovery',
    },
  };
  const registry = new UiJobRegistry({
    createId: () => 'job-blocked',
    now: () => new Date('2026-09-08T10:00:00.000Z'),
  });

  registry.start('resume_research', 'research-1', async () => blocked);
  await flushPromises();

  const finished = registry.get('job-blocked');
  assert.equal(finished?.state, 'finished');
  assert.equal(finished?.result?.exitCode, 2);
  assert.equal(finished?.result?.workflowState, 'blocked');
  assert.equal(finished?.error, null);
});

test('job registry records thrown ResearchError without converting it into durable runner state', async () => {
  const registry = new UiJobRegistry({
    createId: () => 'job-failed',
    now: () => new Date('2026-09-08T10:00:00.000Z'),
  });

  registry.start('resume_research', 'research-1', async () => {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'bad resume');
  });
  await flushPromises();

  const failed = registry.get('job-failed');
  assert.equal(failed?.state, 'failed');
  assert.deepEqual(failed?.error, { code: 'INPUT_SCHEMA_ERROR', message: 'bad resume' });
  assert.equal(failed?.result, null);
});

test('finished-job retention is a strict bound immediately after each completion', async () => {
  let id = 0;
  let tick = 0;
  const registry = new UiJobRegistry({
    retainFinished: 2,
    createId: () => `job-${++id}`,
    now: () => new Date(Date.UTC(2026, 8, 8, 10, 0, tick++)),
  });

  registry.start('create_research', null, async () => EXECUTION);
  await flushPromises();
  registry.start('resume_research', 'research-1', async () => EXECUTION);
  await flushPromises();
  registry.start('resume_research', 'research-1', async () => EXECUTION);
  await flushPromises();

  const jobs = registry.list();
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => job.jobId), ['job-3', 'job-2']);
  assert.equal(registry.get('job-1'), null);
});

test('job registry rejects invalid retention limits instead of becoming accidentally unbounded', () => {
  assert.throws(() => new UiJobRegistry({ retainFinished: -1 }), /non-negative integer/);
  assert.throws(() => new UiJobRegistry({ retainFinished: 1.5 }), /non-negative integer/);
});

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
