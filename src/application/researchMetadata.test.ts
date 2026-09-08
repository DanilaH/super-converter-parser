import assert from 'node:assert/strict';
import test from 'node:test';
import type { RenameResearchLabelDeps } from './researchMetadata.js';
import { renameResearchLabel } from './researchMetadata.js';

function deps(sequence: string[], overrides: Partial<RenameResearchLabelDeps> = {}): RenameResearchLabelDeps {
  return {
    acquireResearchLock: async (_outputRoot, researchId) => {
      sequence.push(`lock:${researchId}`);
      return {
        researchId: 'research-1',
        researchDirectory: '/output/research-1',
        release: async () => { sequence.push('release'); },
      };
    },
    updateDisplayLabel: async (_directory, label, now) => {
      sequence.push(`update:${label}`);
      return {
        version: 1,
        researchId: 'research-1',
        researchDirectory: '/output/research-1',
        previousLabel: 'Old label',
        label,
        changed: true,
        updatedAt: now.toISOString(),
      };
    },
    archiveResearchDirectory: async () => {
      sequence.push('archive');
      return '/output/research-1/results.zip';
    },
    ...overrides,
  };
}

test('display label rename trims input, serializes with the composite research lock, and refreshes derived archive', async () => {
  const sequence: string[] = [];
  const result = await renameResearchLabel(' research-1 ', '  New label  ', {
    outputRoot: '/tmp/research-label-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    now: () => new Date('2026-09-08T12:30:00.000Z'),
    deps: deps(sequence),
  });

  assert.deepEqual(sequence, ['lock:research-1', 'update:New label', 'archive', 'release']);
  assert.equal(result.researchId, 'research-1');
  assert.equal(result.previousLabel, 'Old label');
  assert.equal(result.label, 'New label');
  assert.equal(result.changed, true);
  assert.equal(result.archiveWarning, null);
});

test('idempotent rename skips derived archive refresh', async () => {
  const sequence: string[] = [];
  const base = deps(sequence);
  const result = await renameResearchLabel('research-1', 'Old label', {
    outputRoot: '/tmp/research-label-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    deps: {
      ...base,
      updateDisplayLabel: async () => ({
        version: 1,
        researchId: 'research-1',
        researchDirectory: '/output/research-1',
        previousLabel: 'Old label',
        label: 'Old label',
        changed: false,
        updatedAt: '2026-09-02T00:00:00.000Z',
      }),
    },
  });

  assert.deepEqual(sequence, ['lock:research-1', 'release']);
  assert.equal(result.changed, false);
  assert.equal(result.archiveWarning, null);
});

test('archive refresh failure is reported as a warning after durable label commit', async () => {
  const sequence: string[] = [];
  const result = await renameResearchLabel('research-1', 'New label', {
    outputRoot: '/tmp/research-label-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    deps: deps(sequence, {
      archiveResearchDirectory: async () => {
        sequence.push('archive');
        throw new Error('zip failed');
      },
    }),
  });

  assert.deepEqual(sequence, ['lock:research-1', 'update:New label', 'archive', 'release']);
  assert.equal(result.changed, true);
  assert.equal(result.archiveWarning, 'zip failed');
});

test('rename rejects blank/non-string labels before lock acquisition', async () => {
  const sequence: string[] = [];
  const dependencySet = deps(sequence);
  await assert.rejects(
    () => renameResearchLabel('research-1', '   ', { deps: dependencySet }),
    /must not be blank/,
  );
  await assert.rejects(
    () => renameResearchLabel('research-1', 42, { deps: dependencySet }),
    /must be a string/,
  );
  assert.deepEqual(sequence, []);
});
