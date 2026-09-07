import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';
import {
  inspectResearchLibraryLineage,
  listResearchLibrary,
} from './query.js';
import {
  RESEARCH_LIBRARY_DIRECTORY,
  RESEARCH_LIBRARY_SCHEMA_VERSION,
} from './researchLibrary.js';

type FixturePublication = {
  id: string;
  fingerprint: string;
  sourceRunId: string;
  enrichmentId: string;
  researchName: string;
  researchPath: string;
  publishedAt: string;
  supersedes: string | null;
  keywords?: number;
  clusters?: number;
  finalists?: number;
  entrantDomains?: number;
};

async function createLibraryFixture(
  rows: FixturePublication[],
  schemaVersion = RESEARCH_LIBRARY_SCHEMA_VERSION,
): Promise<string> {
  const outputRoot = await mkdtemp(join(tmpdir(), 'library-query-'));
  const directory = join(outputRoot, RESEARCH_LIBRARY_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const db = new Database(join(directory, 'library.sqlite'));
  try {
    db.exec(`
      CREATE TABLE research_library_schema (
        singleton INTEGER PRIMARY KEY,
        version INTEGER NOT NULL
      );
      CREATE TABLE publications (
        publication_id TEXT PRIMARY KEY,
        snapshot_fingerprint TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        enrichment_id TEXT NOT NULL,
        research_name TEXT NOT NULL,
        research_relative_path TEXT NOT NULL,
        published_at TEXT NOT NULL,
        supersedes_publication_id TEXT,
        keyword_count INTEGER NOT NULL,
        cluster_count INTEGER NOT NULL,
        finalist_count INTEGER NOT NULL,
        entrant_domain_count INTEGER NOT NULL
      );
    `);
    db.prepare('INSERT INTO research_library_schema (singleton, version) VALUES (1, ?)').run(schemaVersion);
    const insert = db.prepare(`
      INSERT INTO publications (
        publication_id, snapshot_fingerprint, source_run_id, enrichment_id,
        research_name, research_relative_path, published_at, supersedes_publication_id,
        keyword_count, cluster_count, finalist_count, entrant_domain_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.id,
        row.fingerprint,
        row.sourceRunId,
        row.enrichmentId,
        row.researchName,
        row.researchPath,
        row.publishedAt,
        row.supersedes,
        row.keywords ?? 10,
        row.clusters ?? 2,
        row.finalists ?? 1,
        row.entrantDomains ?? 3,
      );
    }
  } finally {
    db.close();
  }
  return outputRoot;
}

const P1: FixturePublication = {
  id: 'pub_alpha_v1',
  fingerprint: 'fp_alpha_v1',
  sourceRunId: 'run_alpha_v1',
  enrichmentId: 'enrichment_alpha_v1',
  researchName: 'same-display-name',
  researchPath: '2026-09-01-alpha',
  publishedAt: '2026-09-01T10:00:00.000Z',
  supersedes: null,
};

const P2: FixturePublication = {
  id: 'pub_alpha_v2',
  fingerprint: 'fp_alpha_v2',
  sourceRunId: 'run_alpha_v2',
  enrichmentId: 'enrichment_alpha_v2',
  researchName: 'same-display-name',
  researchPath: '2026-09-01-alpha',
  publishedAt: '2026-09-02T10:00:00.000Z',
  supersedes: 'pub_alpha_v1',
  keywords: 12,
};

const P3_SAME_TIMESTAMP: FixturePublication = {
  id: 'pub_alpha_v3',
  fingerprint: 'fp_alpha_v3',
  sourceRunId: 'run_alpha_v3',
  enrichmentId: 'enrichment_alpha_v3',
  researchName: 'same-display-name',
  researchPath: '2026-09-01-alpha',
  publishedAt: P2.publishedAt,
  supersedes: P2.id,
  keywords: 13,
};

const OTHER: FixturePublication = {
  id: 'pub_other',
  fingerprint: 'fp_other',
  sourceRunId: 'run_other',
  enrichmentId: 'enrichment_other',
  researchName: 'same-display-name',
  researchPath: 'nested/2026-09-03-alpha',
  publishedAt: '2026-09-03T10:00:00.000Z',
  supersedes: null,
};

test('library:list returns a valid empty projection before the Library is initialized', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'library-query-empty-'));
  const result = await listResearchLibrary(outputRoot);
  assert.equal(result.initialized, false);
  assert.equal(result.publicationCount, 0);
  assert.equal(result.researchCount, 0);
  assert.deepEqual(result.researches, []);
});

test('library:list groups versions by persisted research path rather than display name', async () => {
  const outputRoot = await createLibraryFixture([P1, P2, OTHER]);
  const result = await listResearchLibrary(outputRoot);

  assert.equal(result.initialized, true);
  assert.equal(result.publicationCount, 3);
  assert.equal(result.researchCount, 2);
  assert.equal(result.researches[0]?.researchPath, OTHER.researchPath, 'latest logical research should be listed first');

  const alpha = result.researches.find((item) => item.researchPath === P1.researchPath);
  assert.ok(alpha);
  assert.equal(alpha.versionCount, 2);
  assert.equal(alpha.currentPublication.publicationId, P2.id);
  assert.equal(alpha.currentPublication.counts.keywords, 12);
});

test('Library publication ordering uses rowid as a deterministic tie-breaker for equal published_at timestamps', async () => {
  const outputRoot = await createLibraryFixture([P1, P2, P3_SAME_TIMESTAMP]);
  const listed = await listResearchLibrary(outputRoot);
  const alpha = listed.researches.find((item) => item.researchPath === P1.researchPath);
  assert.ok(alpha);
  assert.equal(alpha.currentPublication.publicationId, P3_SAME_TIMESTAMP.id);

  const lineage = await inspectResearchLibraryLineage({
    outputRoot,
    researchPath: P1.researchPath,
  });
  assert.deepEqual(
    lineage.publications.map((item) => item.publicationId),
    [P1.id, P2.id, P3_SAME_TIMESTAMP.id],
  );
  assert.deepEqual(lineage.publications.map((item) => item.current), [false, false, true]);
});

test('library:inspect returns ordered immutable lineage and normalizes Windows separators', async () => {
  const outputRoot = await createLibraryFixture([P1, P2, OTHER]);
  const lineage = await inspectResearchLibraryLineage({
    outputRoot,
    researchPath: '2026-09-01-alpha\\',
  });

  assert.equal(lineage.researchPath, P1.researchPath);
  assert.equal(lineage.versionCount, 2);
  assert.deepEqual(lineage.publications.map((item) => item.publicationId), [P1.id, P2.id]);
  assert.deepEqual(lineage.publications.map((item) => item.versionNumber), [1, 2]);
  assert.deepEqual(lineage.publications.map((item) => item.current), [false, true]);
  assert.equal(lineage.publications[1]?.supersedesPublicationId, P1.id);
});

test('library:inspect fails explicitly for an unknown logical research path', async () => {
  const outputRoot = await createLibraryFixture([P1]);
  await assert.rejects(
    inspectResearchLibraryLineage({ outputRoot, researchPath: 'missing-research' }),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /library:list/.test(error.message),
  );
});

test('read-only Library queries fail closed on an unsupported schema version', async () => {
  const outputRoot = await createLibraryFixture([P1], RESEARCH_LIBRARY_SCHEMA_VERSION + 1);
  await assert.rejects(
    listResearchLibrary(outputRoot),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'DB_ERROR'
      && /unsupported/.test(error.message),
  );
});
