import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import { resolveEnrichmentLocation, resolveRunLocation } from './researchLayout.js';

function writeRunDb(path: string, runId: string): void {
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE runs (run_id TEXT NOT NULL)');
    db.prepare('INSERT INTO runs (run_id) VALUES (?)').run(runId);
  } finally {
    db.close();
  }
}

function writeEnrichmentDb(path: string, enrichmentId: string): void {
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE enrichment_runs (enrichment_id TEXT NOT NULL)');
    db.prepare('INSERT INTO enrichment_runs (enrichment_id) VALUES (?)').run(enrichmentId);
  } finally {
    db.close();
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('run resolver rejects an index whose embedded identity differs from the requested run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-index-embedded-id-'));
  const researchDirectory = join(root, 'research-b');
  const discoveryDirectory = join(researchDirectory, 'discovery');
  await mkdir(discoveryDirectory, { recursive: true });
  writeRunDb(join(discoveryDirectory, 'run.sqlite'), 'run_b');
  await writeJson(join(root, 'index', 'runs', 'run_a.json'), {
    version: 1,
    runId: 'run_b',
    researchDirectory,
    discoveryDirectory,
  });

  await assert.rejects(
    () => resolveRunLocation(root, 'run_a'),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && /identifies run_b, not requested run run_a/.test(error.message),
  );
});

test('run resolver rejects a spoofed index that names A but points at durable run B', async () => {
  const root = await mkdtemp(join(tmpdir(), 'run-index-db-id-'));
  const researchDirectory = join(root, 'research-b');
  const discoveryDirectory = join(researchDirectory, 'discovery');
  await mkdir(discoveryDirectory, { recursive: true });
  writeRunDb(join(discoveryDirectory, 'run.sqlite'), 'run_b');
  await writeJson(join(root, 'index', 'runs', 'run_a.json'), {
    version: 1,
    runId: 'run_a',
    researchDirectory,
    discoveryDirectory,
  });

  await assert.rejects(
    () => resolveRunLocation(root, 'run_a'),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && /run run_a points to a database containing run_b/.test(error.message),
  );
});

test('enrichment resolver rejects an index that points at another durable enrichment identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'enrichment-index-db-id-'));
  const researchDirectory = join(root, 'research-b');
  const enrichmentDirectory = join(researchDirectory, 'enrichment');
  await mkdir(enrichmentDirectory, { recursive: true });
  writeEnrichmentDb(join(enrichmentDirectory, 'enrichment.sqlite'), 'enrichment_b');
  await writeJson(join(root, 'index', 'enrichments', 'enrichment_a.json'), {
    version: 1,
    enrichmentId: 'enrichment_a',
    runId: 'run_b',
    researchDirectory,
    enrichmentDirectory,
  });

  await assert.rejects(
    () => resolveEnrichmentLocation(root, 'enrichment_a'),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && /enrichment enrichment_a points to a database containing enrichment_b/.test(error.message),
  );
});
