import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listResearchCatalog } from './researchCatalog.js';

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeRunIndex(root: string, input: {
  runId: string;
  researchDirectory: string;
  discoveryDirectory: string;
}): Promise<void> {
  const directory = join(root, 'index', 'runs');
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, `${input.runId}.json`), { version: 1, ...input });
}

function batch(batchId: string, resultRunId: string) {
  return {
    batchId,
    createdAt: '2026-09-01T00:00:00.000Z',
    input: { kind: 'seeds', originalPath: 'seeds.csv', storedPath: null },
    sourceRowCount: 1,
    inputUniqueKeywordCount: 1,
    addedKeywordCount: 1,
    duplicateKeywordCount: 0,
    promotedKeywordCount: 0,
    normalizedKeywords: ['keyword'],
    newNormalizedKeywords: ['keyword'],
    promotedNormalizedKeywords: [],
    resultRunId,
  };
}

test('catalog is an honest empty state when the run index has not been initialized', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-catalog-empty-'));
  assert.deepEqual(await listResearchCatalog(root), []);
});

test('catalog groups indexed generations only when research.json supplies durable lineage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-catalog-managed-'));
  const researchDirectory = join(root, 'researches', '2026-09-01-tools');
  const discovery1 = join(researchDirectory, 'discovery');
  const discovery2 = join(researchDirectory, 'discovery-02');
  await mkdir(discovery1, { recursive: true });
  await mkdir(discovery2, { recursive: true });
  await writeRunIndex(root, { runId: 'run-1', researchDirectory, discoveryDirectory: discovery1 });
  await writeRunIndex(root, { runId: 'run-2', researchDirectory, discoveryDirectory: discovery2 });
  await writeJson(join(researchDirectory, 'research.json'), {
    version: 1,
    researchId: 'run-1',
    label: 'Tool research',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    currentRunId: 'run-2',
    batches: [batch('batch-0001', 'run-1'), batch('batch-0002', 'run-2')],
  });
  await writeFile(join(researchDirectory, 'operator-config.json'), '{}', 'utf8');

  const items = await listResearchCatalog(root);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    researchId: 'run-1',
    label: 'Tool research',
    currentRunId: 'run-2',
    knownRunIds: ['run-1', 'run-2'],
    batchCount: 2,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    researchDirectory,
    managed: true,
    operatorConfigAvailable: true,
  });
});

test('catalog does not invent lineage for multiple indexed runs without research.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-catalog-unmanaged-'));
  const researchDirectory = join(root, 'old-research');
  const discovery1 = join(researchDirectory, 'discovery');
  const discovery2 = join(researchDirectory, 'discovery-02');
  await mkdir(discovery1, { recursive: true });
  await mkdir(discovery2, { recursive: true });
  await writeRunIndex(root, { runId: 'old-a', researchDirectory, discoveryDirectory: discovery1 });
  await writeRunIndex(root, { runId: 'old-b', researchDirectory, discoveryDirectory: discovery2 });

  const items = await listResearchCatalog(root);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => ({
    researchId: item.researchId,
    currentRunId: item.currentRunId,
    knownRunIds: item.knownRunIds,
    managed: item.managed,
  })), [
    { researchId: 'old-a', currentRunId: 'old-a', knownRunIds: ['old-a'], managed: false },
    { researchId: 'old-b', currentRunId: 'old-b', knownRunIds: ['old-b'], managed: false },
  ]);
});

test('catalog fails closed when an index filename and embedded run id disagree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-catalog-identity-'));
  const researchDirectory = join(root, 'researches', 'broken');
  const discoveryDirectory = join(researchDirectory, 'discovery');
  await mkdir(discoveryDirectory, { recursive: true });
  const indexDirectory = join(root, 'index', 'runs');
  await mkdir(indexDirectory, { recursive: true });
  await writeJson(join(indexDirectory, 'expected.json'), {
    version: 1,
    runId: 'different',
    researchDirectory,
    discoveryDirectory,
  });

  await assert.rejects(
    () => listResearchCatalog(root),
    /identifies different, not expected/,
  );
});
