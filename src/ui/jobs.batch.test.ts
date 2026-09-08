import assert from 'node:assert/strict';
import test from 'node:test';
import { UiJobBusyError, UiJobRegistry } from './jobs.js';

const batchResult = {
  version: 1 as const,
  researchId: 'research-1',
  researchDirectory: '/output/research-1',
  batchId: 'batch-0002',
  previousRunId: 'run-1',
  currentRunId: 'run-2',
  inputUniqueKeywordCount: 3,
  addedKeywordCount: 1,
  duplicateKeywordCount: 2,
  promotedKeywordCount: 1,
  promotedNormalizedKeywords: ['json diff'],
  changed: true,
  discovery: { attempted: true, exitCode: 0, state: 'completed' },
  archiveWarning: null,
};

test('batch job publishes a distinct batch result and stable research identity', async () => {
  const registry = new UiJobRegistry({
    createId: () => 'job-batch',
    now: () => new Date('2026-09-08T12:45:00.000Z'),
  });
  const started = registry.startBatch(' research-1 ', async () => batchResult);
  assert.equal(started.kind, 'append_batch');
  assert.equal(started.researchId, 'research-1');
  assert.equal(started.batchResult, null);
  await flushPromises();

  const finished = registry.get('job-batch');
  assert.equal(finished?.state, 'finished');
  assert.equal(finished?.result, null);
  assert.equal(finished?.repairResult, null);
  assert.deepEqual(finished?.batchResult, batchResult);
});

test('batch job shares the one-active-job admission boundary', async () => {
  let finish: (value: typeof batchResult) => void = () => {
    throw new Error('Deferred batch resolver was not initialized.');
  };
  const pending = new Promise<typeof batchResult>((resolve) => { finish = resolve; });
  const registry = new UiJobRegistry({
    createId: () => 'job-batch-busy',
    now: () => new Date('2026-09-08T12:45:00.000Z'),
  });
  registry.startBatch('research-1', async () => pending);

  assert.throws(
    () => registry.startBatch('research-2', async () => ({ ...batchResult, researchId: 'research-2' })),
    UiJobBusyError,
  );

  finish(batchResult);
  await flushPromises();
});

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
