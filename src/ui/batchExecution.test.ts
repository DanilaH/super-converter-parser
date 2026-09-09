import assert from 'node:assert/strict';
import test from 'node:test';
import type { UiBatchExecutionDeps } from './batchExecution.js';
import { executeUiResearchBatch, previewUiResearchBatch, validateUiBatchDraft } from './batchExecution.js';

function deps(sequence: string[]): UiBatchExecutionDeps {
  return {
    previewResearchBatch: async (researchId, seeds) => {
      sequence.push(`preview:${researchId}:${seeds.length}`);
      return {
        version: 1,
        researchId: 'research-1',
        researchDirectory: '/output/research-1',
        currentRunId: 'run-1',
        batchId: 'batch-0002',
        inputUniqueKeywordCount: seeds.length,
        addedKeywordCount: 1,
        duplicateKeywordCount: 1,
        promotedKeywordCount: 1,
        promotedNormalizedKeywords: ['alpha'],
        changed: true,
      };
    },
    appendResearchBatch: async (researchId, seedsPath, seeds) => {
      sequence.push(`append:${researchId}:${seeds.length}`);
      assert.match(seedsPath, /runner-ui-batch-/);
      return {
        version: 1,
        researchId: 'research-1',
        researchDirectory: '/output/research-1',
        batchId: 'batch-0002',
        previousRunId: 'run-1',
        currentRunId: 'run-2',
        inputUniqueKeywordCount: seeds.length,
        addedKeywordCount: 1,
        duplicateKeywordCount: 1,
        promotedKeywordCount: 1,
        promotedNormalizedKeywords: ['alpha'],
        changed: true,
        discovery: { attempted: true, exitCode: 0, state: 'completed' },
        archiveWarning: null,
      };
    },
    loadSeedRows: async (path) => {
      sequence.push('load');
      assert.match(path, /runner-ui-batch-/);
      return [
        { keyword: 'alpha', rowNumber: 2 },
        { keyword: 'alpha', rowNumber: 3 },
        { keyword: 'beta', rowNumber: 4 },
      ];
    },
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
  };
}

test('batch preview reports supplied lines separately from normalized unique keywords', async () => {
  const sequence: string[] = [];
  const preview = await previewUiResearchBatch('research-1', {
    version: 1,
    keywords: 'alpha\nalpha\nbeta\n',
  }, {}, deps(sequence));

  assert.equal(preview.inputLineCount, 3);
  assert.equal(preview.inputUniqueKeywordCount, 2);
  assert.equal(preview.addedKeywordCount, 1);
  assert.equal(preview.duplicateKeywordCount, 1);
  assert.equal(preview.promotedKeywordCount, 1);
  assert.deepEqual(sequence, ['preview:research-1:2']);
});

test('batch execution starts Research Chrome before materializing seeds and appending discovery', async () => {
  const sequence: string[] = [];
  const result = await executeUiResearchBatch('research-1', {
    version: 1,
    keywords: 'alpha\nalpha\nbeta\n',
  }, {}, deps(sequence));

  assert.deepEqual(sequence, ['chrome', 'load', 'append:research-1:2']);
  assert.equal(result.currentRunId, 'run-2');
  assert.equal(result.discovery.attempted, true);
});

test('batch draft validation is exact and rejects empty seed text', () => {
  assert.throws(() => validateUiBatchDraft({ version: 1, keywords: '   \n' }), /At least one non-empty/);
  assert.throws(() => validateUiBatchDraft({ version: 1, keywords: 'alpha', extra: true }), /exactly version and keywords/);
  assert.throws(() => validateUiBatchDraft({ version: 2, keywords: 'alpha' }), /version: 1/);
});
