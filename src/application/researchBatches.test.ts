import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiscoveryRunResult } from '../discovery/runDiscovery.js';
import type { ResearchContainer } from '../research/batches.js';
import { appendResearchBatch, previewResearchBatch, type ResearchBatchDeps } from './researchBatches.js';

const seeds = [{ keyword: 'alpha', normalizedKeyword: 'alpha', sourceRows: [2] }];

const container: ResearchContainer = {
  version: 1,
  researchId: 'research-1',
  label: 'Research',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  currentRunId: 'run-1',
  batches: [{
    batchId: 'batch-0001',
    createdAt: '2026-09-01T00:00:00.000Z',
    input: { kind: 'seeds', originalPath: '/input.csv', storedPath: null },
    sourceRowCount: 1,
    inputUniqueKeywordCount: 1,
    addedKeywordCount: 1,
    duplicateKeywordCount: 0,
    promotedKeywordCount: 0,
    normalizedKeywords: ['base'],
    newNormalizedKeywords: ['base'],
    promotedNormalizedKeywords: [],
    resultRunId: 'research-1',
  }],
};

function deps(sequence: string[], changed = true): ResearchBatchDeps {
  return {
    previewAppend: async ({ targetRunId }) => {
      sequence.push(`preview:${targetRunId}`);
      return {
        version: 1,
        researchId: 'research-1',
        researchDirectory: '/output/research-1',
        currentRunId: 'run-1',
        batchId: 'batch-0002',
        inputUniqueKeywordCount: 1,
        addedKeywordCount: 1,
        duplicateKeywordCount: 0,
        promotedKeywordCount: 0,
        promotedNormalizedKeywords: [],
        changed: true,
      };
    },
    acquireAppendLock: async (_outputRoot, targetRunId) => {
      sequence.push(`lock:${targetRunId}`);
      return {
        researchId: 'research-1',
        researchDirectory: '/output/research-1',
        release: async () => { sequence.push('release'); },
      };
    },
    readContainer: async () => {
      sequence.push('container');
      return container;
    },
    prepareAppend: async () => {
      sequence.push('prepare');
      return {
        researchId: 'research-1',
        researchDirectory: '/output/research-1',
        previousRunId: 'run-1',
        currentRunId: changed ? 'run-2' : 'run-1',
        batchId: 'batch-0002',
        inputUniqueKeywordCount: 1,
        addedKeywordCount: changed ? 1 : 0,
        duplicateKeywordCount: changed ? 0 : 1,
        promotedKeywordCount: 0,
        promotedNormalizedKeywords: [],
        changed,
      };
    },
    runDiscovery: async (request) => {
      sequence.push('discovery');
      assert.deepEqual(request.input, { kind: 'resume', runId: 'run-2' });
      assert.equal(request.manageProcessSignals, false);
      return {
        exitCode: 0,
        researchId: 'research-1',
        runId: 'run-2',
        researchDirectory: '/output/research-1',
        discoveryDirectory: '/output/research-1/discovery-02',
        state: 'completed',
      } satisfies DiscoveryRunResult;
    },
    archiveResearchDirectory: async () => {
      sequence.push('archive');
      return '/output/research-1/results.zip';
    },
    cliDeps: {} as ResearchBatchDeps['cliDeps'],
  };
}

test('batch preview stays read-only and delegates to the advisory research projection', async () => {
  const sequence: string[] = [];
  const preview = await previewResearchBatch(' research-1 ', seeds, {
    outputRoot: '/tmp/batch-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    deps: deps(sequence),
  });
  assert.equal(preview.batchId, 'batch-0002');
  assert.deepEqual(sequence, ['preview:research-1']);
});

test('changed batch holds the composite lock through authoritative append and resulting discovery', async () => {
  const sequence: string[] = [];
  const result = await appendResearchBatch(' research-1 ', '/tmp/seeds.csv', seeds, {
    outputRoot: '/tmp/batch-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    deps: deps(sequence, true),
  });

  assert.deepEqual(sequence, ['lock:research-1', 'container', 'prepare', 'discovery', 'release']);
  assert.equal(result.researchId, 'research-1');
  assert.equal(result.currentRunId, 'run-2');
  assert.equal(result.changed, true);
  assert.deepEqual(result.discovery, { attempted: true, exitCode: 0, state: 'completed' });
  assert.equal(result.archiveWarning, null);
});

test('metadata-only duplicate batch commits under lock but skips discovery and refreshes archive best-effort', async () => {
  const sequence: string[] = [];
  const result = await appendResearchBatch('research-1', '/tmp/seeds.csv', seeds, {
    outputRoot: '/tmp/batch-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    deps: deps(sequence, false),
  });

  assert.deepEqual(sequence, ['lock:research-1', 'container', 'prepare', 'archive', 'release']);
  assert.equal(result.changed, false);
  assert.deepEqual(result.discovery, { attempted: false, exitCode: null, state: null });
});

test('non-zero discovery result remains a finished batch result and triggers portable archive refresh', async () => {
  const sequence: string[] = [];
  const dependencySet = deps(sequence, true);
  dependencySet.runDiscovery = async () => {
    sequence.push('discovery');
    return {
      exitCode: 1,
      researchId: 'research-1',
      runId: 'run-2',
      researchDirectory: '/output/research-1',
      discoveryDirectory: '/output/research-1/discovery-02',
      state: 'completed_with_errors',
    };
  };

  const result = await appendResearchBatch('research-1', '/tmp/seeds.csv', seeds, {
    outputRoot: '/tmp/batch-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    deps: dependencySet,
  });

  assert.deepEqual(sequence, ['lock:research-1', 'container', 'prepare', 'discovery', 'archive', 'release']);
  assert.deepEqual(result.discovery, { attempted: true, exitCode: 1, state: 'completed_with_errors' });
});

test('append fails closed before prepare when the locked research is not managed', async () => {
  const sequence: string[] = [];
  const dependencySet = deps(sequence, true);
  dependencySet.readContainer = async () => {
    sequence.push('container');
    return null;
  };
  await assert.rejects(
    () => appendResearchBatch('research-1', '/tmp/seeds.csv', seeds, {
      outputRoot: '/tmp/batch-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      deps: dependencySet,
    }),
    /no managed research container/,
  );
  assert.deepEqual(sequence, ['lock:research-1', 'container', 'release']);
});
