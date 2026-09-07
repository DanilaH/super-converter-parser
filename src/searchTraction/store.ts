import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';
import type {
  GscSearchTractionSnapshot,
  SearchTractionDimension,
  SearchTractionDimensionRow,
} from './gscExport.js';

export const SEARCH_TRACTION_SCHEMA_VERSION = 1;
export const SEARCH_TRACTION_DIRECTORY = 'first-party-search';

export type PersistSearchTractionResult = {
  snapshotId: string;
  changed: boolean;
  sourceArchiveRestored: boolean;
  databasePath: string;
  sourceArchivePath: string;
  snapshotCount: number;
};

export async function persistGscSearchTractionSnapshot(input: {
  outputRoot: string;
  archive: Buffer;
  snapshot: GscSearchTractionSnapshot;
  now?: () => Date;
}): Promise<PersistSearchTractionResult> {
  const root = resolve(input.outputRoot, SEARCH_TRACTION_DIRECTORY);
  const databasePath = join(root, 'search-traction.sqlite');
  const snapshotId = searchTractionSnapshotId(
    input.snapshot.property,
    input.snapshot.source.sha256,
    input.snapshot.source.parserVersion,
  );
  const sourceArchivePath = join(root, 'sources', `${snapshotId}.zip`);
  const importedAt = (input.now?.() ?? new Date()).toISOString();

  await mkdir(root, { recursive: true });
  const db = new Database(databasePath);
  let sourceArchiveRestored = false;
  let inserted = false;
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 1000');
    applySchema(db);

    const existing = db.prepare(
      'SELECT snapshot_id, property, source_sha256, parser_version FROM snapshots WHERE snapshot_id = ?',
    ).get(snapshotId) as {
      snapshot_id: string;
      property: string;
      source_sha256: string;
      parser_version: string;
    } | undefined;

    if (existing) {
      if (
        existing.property !== input.snapshot.property
        || existing.source_sha256 !== input.snapshot.source.sha256
        || existing.parser_version !== input.snapshot.source.parserVersion
      ) {
        throw new ResearchError('DB_ERROR', `Search traction snapshot identity collision: ${snapshotId}.`);
      }
      sourceArchiveRestored = await ensureSourceArchive(
        sourceArchivePath,
        input.archive,
        input.snapshot.source.sha256,
      );
    } else {
      sourceArchiveRestored = await ensureSourceArchive(
        sourceArchivePath,
        input.archive,
        input.snapshot.source.sha256,
      );
      try {
        const insert = db.transaction(() => {
          db.prepare(`
            INSERT INTO snapshots (
              snapshot_id, property, source_kind, parser_version, source_sha256,
              source_archive_relative_path, imported_at,
              observed_start_date, observed_end_date, total_clicks, total_impressions
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            snapshotId,
            input.snapshot.property,
            input.snapshot.source.kind,
            input.snapshot.source.parserVersion,
            input.snapshot.source.sha256,
            `sources/${snapshotId}.zip`,
            importedAt,
            input.snapshot.observedRange?.startDate ?? null,
            input.snapshot.observedRange?.endDate ?? null,
            input.snapshot.totals.clicks,
            input.snapshot.totals.impressions,
          );

          const dailyStatement = db.prepare(`
            INSERT INTO daily_metrics (
              snapshot_id, ordinal, date, clicks, impressions, ctr_ratio, position
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          input.snapshot.chart.forEach((row, ordinal) => {
            dailyStatement.run(
              snapshotId,
              ordinal,
              row.date,
              row.clicks,
              row.impressions,
              row.ctrRatio,
              row.position,
            );
          });

          const dimensionStatement = db.prepare(`
            INSERT INTO dimension_metrics (
              snapshot_id, dimension, ordinal, value,
              clicks, impressions, ctr_ratio, position
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const [dimension, rows] of dimensionEntries(input.snapshot.dimensions)) {
            rows.forEach((row, ordinal) => {
              dimensionStatement.run(
                snapshotId,
                dimension,
                ordinal,
                row.value,
                row.clicks,
                row.impressions,
                row.ctrRatio,
                row.position,
              );
            });
          }

          const filterStatement = db.prepare(`
            INSERT INTO snapshot_filters (snapshot_id, ordinal, name, value)
            VALUES (?, ?, ?, ?)
          `);
          input.snapshot.filters.forEach((filter, ordinal) => {
            filterStatement.run(snapshotId, ordinal, filter.name, filter.value);
          });
        });
        insert();
        inserted = true;
      } catch (error) {
        // The source ZIP is written before the SQLite transaction so a committed
        // snapshot can never point at an archive that failed to persist. If this
        // was a newly written orphan for an insert that did not commit, remove it.
        if (sourceArchiveRestored) {
          await rm(sourceArchivePath, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    }

    const row = db.prepare('SELECT COUNT(*) AS count FROM snapshots').get() as { count: number };
    return {
      snapshotId,
      changed: inserted,
      sourceArchiveRestored,
      databasePath,
      sourceArchivePath,
      snapshotCount: row.count,
    };
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError('DB_ERROR', `Failed to persist first-party search traction snapshot ${snapshotId}.`, { cause: error });
  } finally {
    db.close();
  }
}

export function searchTractionSnapshotId(
  property: string,
  sourceSha256: string,
  parserVersion: string,
): string {
  const fingerprint = createHash('sha256')
    .update(property, 'utf8')
    .update('\0')
    .update(sourceSha256, 'utf8')
    .update('\0')
    .update(parserVersion, 'utf8')
    .digest('hex');
  return `gsc_${fingerprint}`;
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_traction_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `);
  const current = db.prepare(
    'SELECT version FROM search_traction_schema WHERE singleton = 1',
  ).get() as { version: number } | undefined;
  if (current && current.version !== SEARCH_TRACTION_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Search traction schema version ${current.version} is unsupported by this build (${SEARCH_TRACTION_SCHEMA_VERSION}).`,
    );
  }
  if (!current) {
    db.prepare(
      'INSERT INTO search_traction_schema (singleton, version) VALUES (1, ?)',
    ).run(SEARCH_TRACTION_SCHEMA_VERSION);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      snapshot_id TEXT PRIMARY KEY,
      property TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      source_archive_relative_path TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      observed_start_date TEXT,
      observed_end_date TEXT,
      total_clicks INTEGER NOT NULL,
      total_impressions INTEGER NOT NULL,
      UNIQUE(property, source_sha256, parser_version)
    );
    CREATE INDEX IF NOT EXISTS snapshots_property_idx
      ON snapshots(property, imported_at);

    CREATE TABLE IF NOT EXISTS daily_metrics (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      date TEXT NOT NULL,
      clicks INTEGER NOT NULL,
      impressions INTEGER NOT NULL,
      ctr_ratio REAL,
      position REAL,
      PRIMARY KEY (snapshot_id, ordinal),
      UNIQUE(snapshot_id, date)
    );

    CREATE TABLE IF NOT EXISTS dimension_metrics (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
      dimension TEXT NOT NULL CHECK (
        dimension IN ('query', 'page', 'country', 'device', 'search_appearance')
      ),
      ordinal INTEGER NOT NULL,
      value TEXT NOT NULL,
      clicks INTEGER NOT NULL,
      impressions INTEGER NOT NULL,
      ctr_ratio REAL,
      position REAL,
      PRIMARY KEY (snapshot_id, dimension, ordinal)
    );
    CREATE INDEX IF NOT EXISTS dimension_metrics_value_idx
      ON dimension_metrics(dimension, value);

    CREATE TABLE IF NOT EXISTS snapshot_filters (
      snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, ordinal)
    );
  `);
}

async function ensureSourceArchive(path: string, archive: Buffer, expectedSha256: string): Promise<boolean> {
  let existingNeedsReplacement = false;
  try {
    const existing = await readFile(path);
    if (sha256(existing) === expectedSha256) return false;
    existingNeedsReplacement = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new ResearchError('OUTPUT_WRITE_ERROR', `Cannot inspect first-party source archive ${path}.`, { cause: error });
    }
  }

  if (sha256(archive) !== expectedSha256) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', 'GSC source archive hash changed between parsing and persistence.');
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    // Write the complete replacement before touching an existing target. Windows
    // does not reliably allow rename() to replace an existing file, so remove the
    // known-bad target only after the temp file is safely written.
    await writeFile(temp, archive);
    if (existingNeedsReplacement) {
      await rm(path, { force: true });
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Cannot persist first-party source archive ${path}.`, { cause: error });
  }
  return true;
}

function dimensionEntries(
  value: Record<SearchTractionDimension, SearchTractionDimensionRow[]>,
): Array<[SearchTractionDimension, SearchTractionDimensionRow[]]> {
  return Object.entries(value) as Array<[SearchTractionDimension, SearchTractionDimensionRow[]]>;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
