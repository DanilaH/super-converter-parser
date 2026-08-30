import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';

/**
 * Rebuild the supersedes chain for every immutable library publication produced
 * from the same top-level research directory as the current publication.
 *
 * Before research batches, enrichment_id happened to be a sufficient lineage
 * key. A batch append creates a new source run and therefore a new enrichment
 * id while deliberately keeping the same research directory. The persisted
 * research_relative_path is already a durable column in schema v1, so it can
 * extend lineage without a library schema migration.
 */
export function relinkResearchPublicationHistory(
  libraryDbPath: string,
  publicationId: string,
): string | null {
  const db = new Database(libraryDbPath);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 1000');
    const current = db.prepare(`
      SELECT research_relative_path
      FROM publications
      WHERE publication_id = ?
    `).get(publicationId) as { research_relative_path: string } | undefined;
    if (!current) {
      throw new ResearchError(
        'DB_ERROR',
        `Library publication not found while rebuilding research lineage: ${publicationId}.`,
      );
    }

    const rows = db.prepare(`
      SELECT publication_id
      FROM publications
      WHERE research_relative_path = ?
      ORDER BY published_at ASC, rowid ASC
    `).all(current.research_relative_path) as Array<{ publication_id: string }>;

    const update = db.prepare(`
      UPDATE publications
      SET supersedes_publication_id = ?
      WHERE publication_id = ?
    `);
    const tx = db.transaction(() => {
      let previous: string | null = null;
      for (const row of rows) {
        update.run(previous, row.publication_id);
        previous = row.publication_id;
      }
    });
    tx();

    const currentIndex = rows.findIndex((row) => row.publication_id === publicationId);
    if (currentIndex < 0) {
      throw new ResearchError(
        'DB_ERROR',
        `Library publication disappeared while rebuilding research lineage: ${publicationId}.`,
      );
    }
    return currentIndex === 0 ? null : rows[currentIndex - 1]!.publication_id;
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError(
      'DB_ERROR',
      `Failed to rebuild research publication lineage in ${libraryDbPath}.`,
      { cause: error },
    );
  } finally {
    db.close();
  }
}
