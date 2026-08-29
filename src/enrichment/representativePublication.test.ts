import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRepresentativeMetadata } from './representativePublication.js';

const CONFIG = {
  targetCount: 5,
  overrides: [],
  setVersion: '1.0.0',
  selectedClusterIds: ['cluster-1', 'cluster-2'],
};

async function createPublication(directory: string): Promise<void> {
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    modules: ['clusters'],
    config: { clusters: { algorithmVersion: '2.0.0' } },
    artifacts: ['keyword-clusters.csv', 'keyword-clusters.json', 'manifest.json', 'status.json'],
    summary: { clusterCount: 2 },
    state: 'completed',
  }, null, 2) + '\n');
  await writeFile(join(directory, 'status.json'), JSON.stringify({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    status: 'completed',
    modules: ['clusters'],
    artifacts: ['keyword-clusters.csv', 'keyword-clusters.json', 'manifest.json', 'status.json'],
    summary: { clusterCount: 2 },
  }, null, 2) + '\n');
}

test('publication adds representative artifacts, finalist scope and config without erasing existing metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'representative-publication-'));
  try {
    await createPublication(directory);
    await publishRepresentativeMetadata({
      enrichmentDirectory: directory,
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      config: CONFIG,
      summary: {
        revision: 1,
        changed: true,
        setVersion: '1.0.0',
        targetCount: 5,
        setCount: 2,
        queryCount: 4,
        manualOverrideCount: 0,
      },
    });

    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      config: Record<string, unknown>;
      artifacts: string[];
      summary: { clusterCount: number };
      representativeQueries: { revision: number };
    };
    const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')) as {
      artifacts: string[];
      representativeQueries: { revision: number };
    };
    assert.equal(manifest.summary.clusterCount, 2);
    assert.equal(manifest.representativeQueries.revision, 1);
    assert.deepEqual(manifest.config.representative_queries, CONFIG);
    assert.equal(manifest.artifacts.includes('representative-queries.csv'), true);
    assert.equal(status.artifacts.includes('representative-queries.json'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publication is idempotent and does not duplicate artifact names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'representative-publication-repeat-'));
  try {
    await createPublication(directory);
    const input = {
      enrichmentDirectory: directory,
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      config: CONFIG,
      summary: {
        revision: 1,
        changed: false,
        setVersion: '1.0.0',
        targetCount: 5,
        setCount: 2,
        queryCount: 4,
        manualOverrideCount: 0,
      },
    };
    await publishRepresentativeMetadata(input);
    await publishRepresentativeMetadata(input);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      artifacts: string[];
    };
    assert.equal(manifest.artifacts.filter((name) => name === 'representative-queries.csv').length, 1);
    assert.equal(manifest.artifacts.filter((name) => name === 'representative-queries.json').length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publication refuses mismatched enrichment identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'representative-publication-mismatch-'));
  try {
    await createPublication(directory);
    await assert.rejects(
      publishRepresentativeMetadata({
        enrichmentDirectory: directory,
        enrichmentId: 'wrong',
        sourceRunId: 'source-1',
        config: CONFIG,
        summary: {
          revision: 1,
          changed: true,
          setVersion: '1.0.0',
          targetCount: 5,
          setCount: 2,
          queryCount: 4,
          manualOverrideCount: 0,
        },
      }),
      /does not belong to enrichment/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
