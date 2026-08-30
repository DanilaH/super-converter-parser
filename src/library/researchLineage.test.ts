import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { relinkResearchPublicationHistory } from './researchLineage.js';

test('research lineage spans different enrichment ids in one research folder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'research-lineage-'));
  const dbPath = join(directory, 'library.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE publications (
        publication_id TEXT PRIMARY KEY,
        enrichment_id TEXT NOT NULL,
        research_relative_path TEXT NOT NULL,
        published_at TEXT NOT NULL,
        supersedes_publication_id TEXT
      );
    `);
    const insert = db.prepare(`
      INSERT INTO publications (
        publication_id, enrichment_id, research_relative_path,
        published_at, supersedes_publication_id
      ) VALUES (?, ?, ?, ?, ?)
    `);
    insert.run('pub-a', 'enrichment-a', '2026-08-30-favicon', '2026-08-30T01:00:00.000Z', null);
    insert.run('pub-b', 'enrichment-a', '2026-08-30-favicon', '2026-08-30T02:00:00.000Z', 'pub-a');
    insert.run('pub-c', 'enrichment-b', '2026-08-30-favicon', '2026-08-30T03:00:00.000Z', null);
    insert.run('pub-other', 'enrichment-x', '2026-08-30-audio', '2026-08-30T04:00:00.000Z', null);
  } finally {
    db.close();
  }

  assert.equal(relinkResearchPublicationHistory(dbPath, 'pub-c'), 'pub-b');

  const verify = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = verify.prepare(`
      SELECT publication_id, supersedes_publication_id
      FROM publications
      ORDER BY publication_id
    `).all() as Array<{ publication_id: string; supersedes_publication_id: string | null }>;
    const byId = new Map(rows.map((row) => [row.publication_id, row.supersedes_publication_id]));
    assert.equal(byId.get('pub-a'), null);
    assert.equal(byId.get('pub-b'), 'pub-a');
    assert.equal(byId.get('pub-c'), 'pub-b');
    assert.equal(byId.get('pub-other'), null);
  } finally {
    verify.close();
  }
});
