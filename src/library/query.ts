import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';
import {
  RESEARCH_LIBRARY_DIRECTORY,
  RESEARCH_LIBRARY_SCHEMA_VERSION,
} from './researchLibrary.js';

export const RESEARCH_LIBRARY_QUERY_VERSION = '1.0.0' as const;

export type LibraryPublicationSummary = {
  publicationId: string;
  snapshotFingerprint: string;
  sourceRunId: string;
  enrichmentId: string;
  publishedAt: string;
  supersedesPublicationId: string | null;
  counts: {
    keywords: number;
    clusters: number;
    finalists: number;
    entrantDomains: number;
  };
};

export type LibraryResearchSummary = {
  researchPath: string;
  researchName: string;
  versionCount: number;
  currentPublication: LibraryPublicationSummary;
};

export type ResearchLibraryList = {
  version: typeof RESEARCH_LIBRARY_QUERY_VERSION;
  initialized: boolean;
  libraryDbPath: string;
  publicationCount: number;
  researchCount: number;
  researches: LibraryResearchSummary[];
};

export type ResearchLibraryLineage = {
  version: typeof RESEARCH_LIBRARY_QUERY_VERSION;
  libraryDbPath: string;
  researchPath: string;
  researchName: string;
  versionCount: number;
  publications: Array<LibraryPublicationSummary & {
    versionNumber: number;
    current: boolean;
  }>;
};

type PublicationRow = {
  publication_id: string;
  snapshot_fingerprint: string;
  source_run_id: string;
  enrichment_id: string;
  research_name: string;
  research_relative_path: string;
  published_at: string;
  supersedes_publication_id: string | null;
  keyword_count: number;
  cluster_count: number;
  finalist_count: number;
  entrant_domain_count: number;
};

type LibraryRows = {
  initialized: boolean;
  dbPath: string;
  rows: PublicationRow[];
};

export async function listResearchLibrary(outputRoot: string): Promise<ResearchLibraryList> {
  const loaded = await loadPublicationRows(outputRoot);
  if (!loaded.initialized) {
    return {
      version: RESEARCH_LIBRARY_QUERY_VERSION,
      initialized: false,
      libraryDbPath: loaded.dbPath,
      publicationCount: 0,
      researchCount: 0,
      researches: [],
    };
  }

  const grouped = new Map<string, PublicationRow[]>();
  for (const row of loaded.rows) {
    const group = grouped.get(row.research_relative_path) ?? [];
    group.push(row);
    grouped.set(row.research_relative_path, group);
  }

  const researches: LibraryResearchSummary[] = [...grouped.entries()]
    .map(([researchPath, rows]) => {
      const current = rows.at(-1);
      if (!current) throw new ResearchError('DB_ERROR', `Research Library group ${researchPath} has no publications.`);
      return {
        researchPath,
        researchName: current.research_name,
        versionCount: rows.length,
        currentPublication: projectPublication(current),
      };
    })
    .sort((a, b) => {
      const byPublishedAt = b.currentPublication.publishedAt.localeCompare(a.currentPublication.publishedAt);
      return byPublishedAt !== 0 ? byPublishedAt : a.researchPath.localeCompare(b.researchPath);
    });

  return {
    version: RESEARCH_LIBRARY_QUERY_VERSION,
    initialized: true,
    libraryDbPath: loaded.dbPath,
    publicationCount: loaded.rows.length,
    researchCount: researches.length,
    researches,
  };
}

export async function inspectResearchLibraryLineage(input: {
  outputRoot: string;
  researchPath: string;
}): Promise<ResearchLibraryLineage> {
  const researchPath = normalizeResearchPath(input.researchPath);
  const loaded = await loadPublicationRows(input.outputRoot);
  if (!loaded.initialized) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research Library is not initialized under ${resolve(input.outputRoot)}.`,
    );
  }

  const rows = loaded.rows.filter((row) => row.research_relative_path === researchPath);
  if (rows.length === 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research Library has no logical research with path "${researchPath}". Run library:list to inspect available paths.`,
    );
  }

  const current = rows.at(-1)!;
  return {
    version: RESEARCH_LIBRARY_QUERY_VERSION,
    libraryDbPath: loaded.dbPath,
    researchPath,
    researchName: current.research_name,
    versionCount: rows.length,
    publications: rows.map((row, index) => ({
      ...projectPublication(row),
      versionNumber: index + 1,
      current: index === rows.length - 1,
    })),
  };
}

async function loadPublicationRows(outputRoot: string): Promise<LibraryRows> {
  const dbPath = join(resolve(outputRoot), RESEARCH_LIBRARY_DIRECTORY, 'library.sqlite');
  try {
    await access(dbPath);
  } catch (error) {
    if (isEnoent(error)) return { initialized: false, dbPath, rows: [] };
    throw new ResearchError('DB_ERROR', `Cannot inspect Research Library database ${dbPath}.`, { cause: error });
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const schema = db.prepare(
      'SELECT version FROM research_library_schema WHERE singleton = 1',
    ).get() as { version: number } | undefined;
    if (!schema) {
      throw new ResearchError('DB_ERROR', `Research Library database ${dbPath} has no schema version row.`);
    }
    if (schema.version !== RESEARCH_LIBRARY_SCHEMA_VERSION) {
      throw new ResearchError(
        'DB_ERROR',
        `Research Library schema version ${schema.version} is unsupported by this build (${RESEARCH_LIBRARY_SCHEMA_VERSION}).`,
      );
    }

    const rows = db.prepare(`
      SELECT
        publication_id,
        snapshot_fingerprint,
        source_run_id,
        enrichment_id,
        research_name,
        research_relative_path,
        published_at,
        supersedes_publication_id,
        keyword_count,
        cluster_count,
        finalist_count,
        entrant_domain_count
      FROM publications
      ORDER BY research_relative_path ASC, published_at ASC, rowid ASC
    `).all() as PublicationRow[];
    return { initialized: true, dbPath, rows };
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError('DB_ERROR', `Failed to query Research Library database ${dbPath}.`, { cause: error });
  } finally {
    db?.close();
  }
}

function projectPublication(row: PublicationRow): LibraryPublicationSummary {
  return {
    publicationId: row.publication_id,
    snapshotFingerprint: row.snapshot_fingerprint,
    sourceRunId: row.source_run_id,
    enrichmentId: row.enrichment_id,
    publishedAt: row.published_at,
    supersedesPublicationId: row.supersedes_publication_id,
    counts: {
      keywords: row.keyword_count,
      clusters: row.cluster_count,
      finalists: row.finalist_count,
      entrantDomains: row.entrant_domain_count,
    },
  };
}

function normalizeResearchPath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--research-path must be a non-empty relative Library research path.');
  }
  return normalized;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
