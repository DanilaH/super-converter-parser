import Database from 'better-sqlite3';
import { ResearchError } from '../shared/errors.js';
import type { RepresentativeQueryRunConfigSnapshot } from '../enrichment/types.js';
import {
  MAX_REPRESENTATIVE_QUERY_COUNT,
  REPRESENTATIVE_QUERY_SET_VERSION,
  validateRepresentativeQueriesConfig,
  type RepresentativeQuerySet,
} from '../enrichment/representativeQueries.js';
import type { RunStore } from './store.js';

// PR-05 ships this extension schema for the first time. Keep the first shipped
// schema at v1 rather than carrying migrations for intermediate unmerged drafts.
export const REPRESENTATIVE_QUERY_SCHEMA_VERSION = 1;

type StoreWithDb = { db: Database.Database };

type RepresentativeSetRow = {
  enrichment_id: string;
  cluster_id: string;
  set_version: string;
  representative_keyword_ids: string;
  representatives_json: string;
  target_count: number;
  cluster_url_count: number;
  covered_url_count: number;
  manual_override: number;
  manual_override_reason: string | null;
  revision: number;
  created_at: string;
};

type RepresentativeRunRow = {
  enrichment_id: string;
  revision: number;
  snapshot_json: string;
  config_json: string;
  updated_at: string;
};

type RepresentativeHistoryRow = {
  enrichment_id: string;
  revision: number;
  snapshot_json: string;
  config_json: string;
  sets_json: string;
  created_at: string;
};

export type RepresentativeQueryState = {
  enrichmentId: string;
  revision: number;
  config: RepresentativeQueryRunConfigSnapshot;
  sets: RepresentativeQuerySet[];
  updatedAt: string;
};

export type RepresentativeQueryRevision = {
  enrichmentId: string;
  revision: number;
  config: RepresentativeQueryRunConfigSnapshot;
  sets: RepresentativeQuerySet[];
  createdAt: string;
};

export type SaveRepresentativeQueryResult = {
  revision: number;
  changed: boolean;
};

function dbOf(store: RunStore): Database.Database {
  // Same localized extension-schema pattern as the retry journal: representative
  // state stays in the existing enrichment.sqlite without expanding core RunStore
  // schema for a feature-owned derived evidence layer.
  return (store as unknown as StoreWithDb).db;
}

function schemaExists(store: RunStore): boolean {
  return Boolean(dbOf(store)
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'representative_query_schema'")
    .get());
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS representative_query_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `);
  const row = db
    .prepare('SELECT version FROM representative_query_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (row && row.version !== REPRESENTATIVE_QUERY_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Representative query schema version ${row.version} is unsupported by this build (${REPRESENTATIVE_QUERY_SCHEMA_VERSION}).`,
    );
  }
  if (!row) {
    db.prepare('INSERT INTO representative_query_schema (singleton, version) VALUES (1, ?)')
      .run(REPRESENTATIVE_QUERY_SCHEMA_VERSION);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_representative_query_runs (
      enrichment_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS enrichment_representative_query_sets (
      enrichment_id TEXT NOT NULL,
      cluster_id TEXT NOT NULL,
      set_version TEXT NOT NULL,
      representative_keyword_ids TEXT NOT NULL,
      representatives_json TEXT NOT NULL,
      target_count INTEGER NOT NULL,
      cluster_url_count INTEGER NOT NULL,
      covered_url_count INTEGER NOT NULL,
      manual_override INTEGER NOT NULL,
      manual_override_reason TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (enrichment_id, cluster_id)
    );

    CREATE TABLE IF NOT EXISTS enrichment_representative_query_history (
      enrichment_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      config_json TEXT NOT NULL,
      sets_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (enrichment_id, revision)
    );
  `);
}

function assertSchemaReadable(store: RunStore): boolean {
  if (!schemaExists(store)) return false;
  const row = dbOf(store)
    .prepare('SELECT version FROM representative_query_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (!row || row.version !== REPRESENTATIVE_QUERY_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Unsupported representative query schema version ${row?.version ?? 'missing'}; expected ${REPRESENTATIVE_QUERY_SCHEMA_VERSION}.`,
    );
  }
  return true;
}

function validateSnapshot(
  config: RepresentativeQueryRunConfigSnapshot,
  sets: RepresentativeQuerySet[],
): void {
  try {
    validateRepresentativeQueriesConfig(config);
  } catch (error) {
    throw new ResearchError(
      'DB_ERROR',
      `Invalid representative query config: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!Array.isArray(config.selectedClusterIds) || config.selectedClusterIds.length === 0) {
    throw new ResearchError('DB_ERROR', 'Representative config must contain at least one selected finalist cluster.');
  }
  const selected = new Set<string>();
  for (const clusterId of config.selectedClusterIds) {
    if (typeof clusterId !== 'string' || clusterId.trim() === '') {
      throw new ResearchError('DB_ERROR', 'Representative config contains an invalid finalist cluster id.');
    }
    if (selected.has(clusterId)) {
      throw new ResearchError('DB_ERROR', `Representative config contains duplicate finalist cluster ${clusterId}.`);
    }
    selected.add(clusterId);
  }

  const overrideByCluster = new Map(config.overrides.map((override) => [override.clusterId, override]));
  for (const override of config.overrides) {
    if (!selected.has(override.clusterId)) {
      throw new ResearchError(
        'DB_ERROR',
        `Representative override for ${override.clusterId} is outside the selected finalist scope.`,
      );
    }
  }
  if (sets.length !== selected.size) {
    throw new ResearchError(
      'DB_ERROR',
      `Representative snapshot has ${sets.length} set(s) for ${selected.size} selected finalist cluster(s).`,
    );
  }

  const seen = new Set<string>();
  for (const set of sets) {
    if (!selected.has(set.clusterId)) {
      throw new ResearchError('DB_ERROR', `Representative set ${set.clusterId} is outside the selected finalist scope.`);
    }
    if (seen.has(set.clusterId)) {
      throw new ResearchError('DB_ERROR', `Duplicate representative set for ${set.clusterId}.`);
    }
    seen.add(set.clusterId);

    if (set.setVersion !== REPRESENTATIVE_QUERY_SET_VERSION || set.setVersion !== config.setVersion) {
      throw new ResearchError(
        'DB_ERROR',
        `Cannot persist representative set ${set.clusterId} with version ${set.setVersion}; expected ${REPRESENTATIVE_QUERY_SET_VERSION}.`,
      );
    }
    if (
      !Number.isInteger(set.targetCount)
      || set.targetCount < 1
      || set.targetCount > MAX_REPRESENTATIVE_QUERY_COUNT
      || set.representativeKeywordIds.length !== set.targetCount
      || set.representatives.length !== set.targetCount
    ) {
      throw new ResearchError(
        'DB_ERROR',
        `Representative set ${set.clusterId} has inconsistent effective target and representative rows.`,
      );
    }
    if (new Set(set.representativeKeywordIds).size !== set.representativeKeywordIds.length) {
      throw new ResearchError('DB_ERROR', `Representative set ${set.clusterId} contains duplicate keyword ids.`);
    }
    if (set.representativeKeywordIds.some((id) => !Number.isInteger(id) || id < 0)) {
      throw new ResearchError('DB_ERROR', `Representative set ${set.clusterId} contains an invalid keyword id.`);
    }
    const rowIds = set.representatives.map((row) => row.keywordIdx);
    if (!set.representativeKeywordIds.every((id, index) => id === rowIds[index])) {
      throw new ResearchError(
        'DB_ERROR',
        `Representative set ${set.clusterId} keyword ids do not match representative rows.`,
      );
    }

    if (
      !Number.isInteger(set.clusterUrlCount)
      || !Number.isInteger(set.coveredUrlCount)
      || set.clusterUrlCount < 0
      || set.coveredUrlCount < 0
      || set.coveredUrlCount > set.clusterUrlCount
    ) {
      throw new ResearchError('DB_ERROR', `Representative set ${set.clusterId} has invalid URL coverage counts.`);
    }
    const gainSum = set.representatives.reduce((sum, row) => {
      if (!Number.isInteger(row.coverageGain) || row.coverageGain < 0) {
        throw new ResearchError('DB_ERROR', `Representative set ${set.clusterId} has invalid coverage gain.`);
      }
      return sum + row.coverageGain;
    }, 0);
    if (gainSum !== set.coveredUrlCount) {
      throw new ResearchError(
        'DB_ERROR',
        `Representative set ${set.clusterId} coverage gains (${gainSum}) do not match coveredUrlCount (${set.coveredUrlCount}).`,
      );
    }

    const override = overrideByCluster.get(set.clusterId);
    if (override) {
      if (!set.manualOverride) {
        throw new ResearchError('DB_ERROR', `Representative override for ${set.clusterId} is not reflected in its persisted set.`);
      }
      if (set.manualOverrideReason !== override.reason) {
        throw new ResearchError('DB_ERROR', `Representative override reason mismatch for ${set.clusterId}.`);
      }
      if (!sameNumberArray(set.representativeKeywordIds, override.keywordIds)) {
        throw new ResearchError('DB_ERROR', `Representative override keyword ids mismatch for ${set.clusterId}.`);
      }
      if (set.representatives.some((row) => row.selectionReason !== 'manual_override')) {
        throw new ResearchError('DB_ERROR', `Manual representative set ${set.clusterId} contains an automatic selection reason.`);
      }
    } else {
      if (set.manualOverride || set.manualOverrideReason !== null) {
        throw new ResearchError('DB_ERROR', `Automatic representative set ${set.clusterId} carries manual override state.`);
      }
      if (set.representatives.some((row) => row.selectionReason === 'manual_override')) {
        throw new ResearchError('DB_ERROR', `Automatic representative set ${set.clusterId} contains a manual selection reason.`);
      }
    }
  }

  for (const clusterId of selected) {
    if (!seen.has(clusterId)) {
      throw new ResearchError('DB_ERROR', `Representative snapshot is missing selected finalist cluster ${clusterId}.`);
    }
  }
}

function normalizedSnapshot(
  config: RepresentativeQueryRunConfigSnapshot,
  sets: RepresentativeQuerySet[],
): { config: RepresentativeQueryRunConfigSnapshot; sets: RepresentativeQuerySet[]; json: string } {
  const normalizedConfig: RepresentativeQueryRunConfigSnapshot = {
    ...config,
    overrides: [...config.overrides].sort((a, b) => compareClusterIds(a.clusterId, b.clusterId)),
    selectedClusterIds: [...config.selectedClusterIds].sort(compareClusterIds),
  };
  const normalizedSets = [...sets].sort((a, b) => compareClusterIds(a.clusterId, b.clusterId));
  return {
    config: normalizedConfig,
    sets: normalizedSets,
    json: JSON.stringify({ config: normalizedConfig, sets: normalizedSets }),
  };
}

export function saveRepresentativeQuerySnapshot(
  store: RunStore,
  enrichmentId: string,
  config: RepresentativeQueryRunConfigSnapshot,
  sets: RepresentativeQuerySet[],
): SaveRepresentativeQueryResult {
  validateSnapshot(config, sets);
  const normalized = normalizedSnapshot(config, sets);
  const db = dbOf(store);
  let result: SaveRepresentativeQueryResult = { revision: 1, changed: true };

  const tx = db.transaction(() => {
    applySchema(db);
    const previous = db
      .prepare('SELECT revision, snapshot_json FROM enrichment_representative_query_runs WHERE enrichment_id = ?')
      .get(enrichmentId) as { revision: number; snapshot_json: string } | undefined;
    const changed = previous?.snapshot_json !== normalized.json;
    const revision = previous ? previous.revision + (changed ? 1 : 0) : 1;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO enrichment_representative_query_runs
        (enrichment_id, revision, snapshot_json, config_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(enrichment_id) DO UPDATE SET
        revision = excluded.revision,
        snapshot_json = excluded.snapshot_json,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(
      enrichmentId,
      revision,
      normalized.json,
      JSON.stringify(normalized.config),
      now,
    );

    db.prepare('DELETE FROM enrichment_representative_query_sets WHERE enrichment_id = ?')
      .run(enrichmentId);
    const insert = db.prepare(`
      INSERT INTO enrichment_representative_query_sets (
        enrichment_id, cluster_id, set_version, representative_keyword_ids,
        representatives_json, target_count, cluster_url_count, covered_url_count,
        manual_override, manual_override_reason, revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const set of normalized.sets) {
      insert.run(
        enrichmentId,
        set.clusterId,
        set.setVersion,
        JSON.stringify(set.representativeKeywordIds),
        JSON.stringify(set.representatives),
        set.targetCount,
        set.clusterUrlCount,
        set.coveredUrlCount,
        set.manualOverride ? 1 : 0,
        set.manualOverrideReason,
        revision,
        now,
      );
    }

    if (changed) {
      db.prepare(`
        INSERT INTO enrichment_representative_query_history
          (enrichment_id, revision, snapshot_json, config_json, sets_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        enrichmentId,
        revision,
        normalized.json,
        JSON.stringify(normalized.config),
        JSON.stringify(normalized.sets),
        now,
      );
    }

    result = { revision, changed };
  });
  tx();
  return result;
}

export function loadRepresentativeQuerySets(
  store: RunStore,
  enrichmentId: string,
): RepresentativeQuerySet[] {
  if (!assertSchemaReadable(store)) return [];
  return loadCurrentSetRows(store, enrichmentId).map((row) => mapSetRow(row, enrichmentId));
}

export function loadRepresentativeQueryState(
  store: RunStore,
  enrichmentId: string,
): RepresentativeQueryState | null {
  if (!assertSchemaReadable(store)) return null;
  const row = dbOf(store)
    .prepare('SELECT * FROM enrichment_representative_query_runs WHERE enrichment_id = ?')
    .get(enrichmentId) as RepresentativeRunRow | undefined;
  if (!row) return null;

  try {
    const config = JSON.parse(row.config_json) as RepresentativeQueryRunConfigSnapshot;
    const setRows = loadCurrentSetRows(store, enrichmentId);
    if (setRows.some((setRow) => setRow.revision !== row.revision)) {
      throw new Error(`current set revision does not match run revision ${row.revision}`);
    }
    const sets = setRows.map((setRow) => mapSetRow(setRow, enrichmentId));
    validateSnapshot(config, sets);
    const normalized = normalizedSnapshot(config, sets);
    if (normalized.json !== row.snapshot_json) {
      throw new Error('current snapshot checksum payload does not match persisted config/sets');
    }
    return {
      enrichmentId: row.enrichment_id,
      revision: row.revision,
      config: normalized.config,
      sets: normalized.sets,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError(
      'DB_ERROR',
      `Corrupt representative query state for enrichment ${enrichmentId}.`,
      { cause: error },
    );
  }
}

export function loadRepresentativeQueryHistory(
  store: RunStore,
  enrichmentId: string,
): RepresentativeQueryRevision[] {
  if (!assertSchemaReadable(store)) return [];
  const rows = dbOf(store)
    .prepare(`
      SELECT * FROM enrichment_representative_query_history
      WHERE enrichment_id = ?
      ORDER BY revision ASC
    `)
    .all(enrichmentId) as RepresentativeHistoryRow[];

  return rows.map((row) => {
    try {
      const config = JSON.parse(row.config_json) as RepresentativeQueryRunConfigSnapshot;
      const sets = JSON.parse(row.sets_json) as RepresentativeQuerySet[];
      validateSnapshot(config, sets);
      const normalized = normalizedSnapshot(config, sets);
      if (normalized.json !== row.snapshot_json) {
        throw new Error(`history snapshot payload does not match revision ${row.revision}`);
      }
      return {
        enrichmentId: row.enrichment_id,
        revision: row.revision,
        config: normalized.config,
        sets: normalized.sets,
        createdAt: row.created_at,
      };
    } catch (error) {
      if (error instanceof ResearchError) throw error;
      throw new ResearchError(
        'DB_ERROR',
        `Corrupt representative query history revision ${row.revision} for enrichment ${enrichmentId}.`,
        { cause: error },
      );
    }
  });
}

function loadCurrentSetRows(store: RunStore, enrichmentId: string): RepresentativeSetRow[] {
  return dbOf(store)
    .prepare(`
      SELECT * FROM enrichment_representative_query_sets
      WHERE enrichment_id = ?
      ORDER BY cluster_id ASC
    `)
    .all(enrichmentId) as RepresentativeSetRow[];
}

function mapSetRow(row: RepresentativeSetRow, enrichmentId: string): RepresentativeQuerySet {
  try {
    const representativeKeywordIds = JSON.parse(row.representative_keyword_ids) as number[];
    const representatives = JSON.parse(row.representatives_json) as RepresentativeQuerySet['representatives'];
    if (!Array.isArray(representativeKeywordIds) || !Array.isArray(representatives)) {
      throw new Error('expected arrays');
    }
    return {
      clusterId: row.cluster_id,
      setVersion: row.set_version,
      representativeKeywordIds,
      representatives,
      targetCount: row.target_count,
      clusterUrlCount: row.cluster_url_count,
      coveredUrlCount: row.covered_url_count,
      manualOverride: row.manual_override === 1,
      manualOverrideReason: row.manual_override_reason,
    };
  } catch (error) {
    throw new ResearchError(
      'DB_ERROR',
      `Corrupt representative query set for ${row.cluster_id} in enrichment ${enrichmentId}.`,
      { cause: error },
    );
  }
}

function sameNumberArray(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function compareClusterIds(a: string, b: string): number {
  const aMatch = /^cluster-(\d+)$/.exec(a);
  const bMatch = /^cluster-(\d+)$/.exec(b);
  if (aMatch && bMatch) {
    const numeric = Number(aMatch[1]) - Number(bMatch[1]);
    if (numeric !== 0) return numeric;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
