import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { inspectResearchLibraryDerivedSnapshots } from './derivedSnapshotHealth.js';
import { buildZip } from './zip.js';

const PUBLICATION_ID = 'pub_fixture';
const SNAPSHOT = 'snapshot-fixture';
const ARCHIVE_RELATIVE = `researches/${PUBLICATION_ID}.zip`;

function libraryJson(supersedesPublicationId: string | null): Buffer {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    generatedAt: '2026-09-02T00:00:00.000Z',
    publicationCount: 1,
    publications: [{
      publicationId: PUBLICATION_ID,
      snapshotFingerprint: SNAPSHOT,
      supersedesPublicationId,
      archivePath: ARCHIVE_RELATIVE,
    }],
  }, null, 2)}\n`, 'utf8');
}

async function writeMasterZip(
  libraryDirectory: string,
  jsonData: Buffer,
): Promise<void> {
  const dbData = await readFile(join(libraryDirectory, 'library.sqlite'));
  const publicationArchive = await readFile(join(libraryDirectory, ARCHIVE_RELATIVE));
  const archive = buildZip([
    { name: 'library.sqlite', data: dbData },
    { name: 'library.json', data: jsonData },
    { name: ARCHIVE_RELATIVE, data: publicationArchive },
  ], new Date('2026-09-02T00:00:00.000Z'));
  await writeFile(join(libraryDirectory, 'library.zip'), archive);
}

test('derived Library health detects DB commit and ZIP/JSON crash windows independently', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'library-derived-health-'));
  const libraryDirectory = join(outputRoot, 'research-library');
  await mkdir(join(libraryDirectory, 'researches'), { recursive: true });
  await writeFile(join(libraryDirectory, ARCHIVE_RELATIVE), 'immutable publication archive', 'utf8');

  const dbPath = join(libraryDirectory, 'library.sqlite');
  let db = new Database(dbPath);
  db.exec(`
    CREATE TABLE publications (
      publication_id TEXT PRIMARY KEY,
      snapshot_fingerprint TEXT NOT NULL,
      supersedes_publication_id TEXT,
      archive_relative_path TEXT NOT NULL,
      published_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO publications (
      publication_id, snapshot_fingerprint, supersedes_publication_id,
      archive_relative_path, published_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(PUBLICATION_ID, SNAPSHOT, null, ARCHIVE_RELATIVE, '2026-09-02T00:00:00.000Z');
  db.close();

  const initialJson = libraryJson(null);
  await writeFile(join(libraryDirectory, 'library.json'), initialJson);
  await writeMasterZip(libraryDirectory, initialJson);

  let health = await inspectResearchLibraryDerivedSnapshots(outputRoot);
  assert.equal(health.current, true);
  assert.equal(health.jsonCurrent, true);
  assert.equal(health.archiveCurrent, true);
  assert.equal(health.warning, null);

  // Simulate the durable relink/commit succeeding before either derived master
  // snapshot is regenerated.
  db = new Database(dbPath);
  db.prepare('UPDATE publications SET supersedes_publication_id = ? WHERE publication_id = ?')
    .run('pub_previous', PUBLICATION_ID);
  db.close();

  health = await inspectResearchLibraryDerivedSnapshots(outputRoot);
  assert.equal(health.current, false);
  assert.equal(health.jsonCurrent, false);
  assert.equal(health.archiveCurrent, false);
  assert.match(health.warning ?? '', /library\.json does not match/);
  assert.match(health.warning ?? '', /library\.zip embeds stale/);

  // Simulate a retry that managed to rewrite library.json but crashed before
  // replacing library.zip. The stale ZIP must still keep repair actionable.
  const repairedJson = libraryJson('pub_previous');
  await writeFile(join(libraryDirectory, 'library.json'), repairedJson);
  health = await inspectResearchLibraryDerivedSnapshots(outputRoot);
  assert.equal(health.current, false);
  assert.equal(health.jsonCurrent, true);
  assert.equal(health.archiveCurrent, false);
  assert.match(health.warning ?? '', /library\.zip embeds stale/);

  await writeMasterZip(libraryDirectory, repairedJson);
  health = await inspectResearchLibraryDerivedSnapshots(outputRoot);
  assert.equal(health.current, true);
  assert.equal(health.jsonCurrent, true);
  assert.equal(health.archiveCurrent, true);
});
