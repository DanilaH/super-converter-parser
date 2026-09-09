import assert from 'node:assert/strict';
import test from 'node:test';
import type { UiBatchExecutionDeps } from './batchExecution.js';
import { executeUiResearchBatch, previewUiResearchBatch, validateUiBatchDraft } from './batchExecution.js';

function deps(sequence: string[], changed = true): UiBatchExecutionDeps {
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
        addedKeywordCount: changed ? 1 : 0,
        duplicateKeywordCount: changed ? 1 : seeds.length,
        promotedKeywordCount: changed ? 1 : 0,
        promotedNormalizedKeywords: changed ? ['alpha'] : [],
        changed,
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
        currentRunId: changed ? 'run-2' : 'run-1',
        inputUniqueKeywordCount: seeds.length,
        addedKeywordCount: changed ? 1 : 0,
        duplicateKeywordCount: changed ? 1 : seeds.length,
        promotedKeywordCount: changed ? 1 : 0,
        promotedNormalizedKeywords: changed ? ['alpha'] : [],
        changed,
        discovery: { attempted: changed, exitCode: changed ? 0 : null, state: changed ? 'completed' : null },
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

test('batch execution starts Research Chrome only after current batch preview confirms discovery changes', async () => {
  const sequence: string[] = [];
  const result = await executeUiResearchBatch('research-1', {
    version: 1,
    keywords: 'alpha\nalpha\nbeta\n',
  }, {}, deps(sequence));

  assert.deepEqual(sequence, ['load', 'preview:research-1:2', 'chrome', 'append:research-1:2']);
  assert.equal(result.currentRunId, 'run-2');
  assert.equal(result.discovery.attempted, true);
});

test('duplicate-only batch does not start Research Chrome when no discovery generation is needed', async () => {
  const sequence: string[] = [];
  const result = await executeUiResearchBatch('research-1', {
    version: 1,
    keywords: 'alpha\nalpha\nbeta\n',
  }, {}, deps(sequence, false));

  assert.deepEqual(sequence, ['load', 'preview:research-1:2', 'append:research-1:2']);
  assert.equal(result.currentRunId, 'run-1');
  assert.equal(result.discovery.attempted, false);
});

test('batch draft validation is exact and rejects empty seed text', () => {
  assert.throws(() => validateUiBatchDraft({ version: 1, keywords: '   \n' }), /At least one non-empty/);
  assert.throws(() => validateUiBatchDraft({ version: 1, keywords: 'alpha', extra: true }), /exactly version and keywords/);
  assert.throws(() => validateUiBatchDraft({ version: 2, keywords: 'alpha' }), /version: 1/);
});
