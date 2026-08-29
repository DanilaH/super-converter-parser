import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  TRAFFIC_EVIDENCE_VERSION,
  normalizeTrafficSnapshots,
  projectTrafficEvidence,
  validateTrafficEvidencePolicy,
  type TrafficEvidencePolicy,
  type TrafficSnapshot,
  type TrafficSnapshotInput,
} from '../enrichment/trafficEvidence.js';
import { ResearchError } from '../shared/errors.js';
import { entrantCohortFingerprint } from './cohortHistory.js';
import { loadEntrantCohortState } from './entrantCohorts.js';
import type { RunStore } from './store.js';

export const TRAFFIC_EVIDENCE_SCHEMA_VERSION = 1;

type StoreWithDb = { db: Database.Database };

type TrafficImportRow = {
  enrichment_id: string;
  snapshot_id: string;
  entrant_fingerprint: string;
  target_cluster_id: string;
  scope: string;
  normalized_entity: string;
  provider_data_date: string;
  observed_at: string;
  market: string;
  source: string;
  snapshot_json: string;
  imported_at: string;
};

export type TrafficImportRecord = {
  snapshotId: string;
  entrantFingerprint: string;
  snapshot: TrafficSnapshot;
  importedAt: string;
};

export type AppendTrafficSnapshotsResult = {
  inserted: number;
  duplicates: number;
};

function dbOf(store: RunStore): Database.Database {
  return (store as unknown as StoreWithDb).db;
}

function schemaExists(store: RunStore): boolean {
  return Boolean(dbOf(store)
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'traffic_evidence_schema'")
    .get());
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS traffic_evidence_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `);
  const version = db
    .prepare('SELECT version FROM traffic_evidence_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (version && version.version !== TRAFFIC_EVIDENCE_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Traffic evidence schema version ${version.version} is unsupported by this build (${TRAFFIC_EVIDENCE_SCHEMA_VERSION}).`,
    );
  }
  if (!version) {
    db.prepare('INSERT INTO traffic_evidence_schema (singleton, version) VALUES (1, ?)')
      .run(TRAFFIC_EVIDENCE_SCHEMA_VERSION);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_traffic_evidence_policies (
      enrichment_id TEXT PRIMARY KEY,
      policy_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS enrichment_traffic_evidence_snapshots (
      enrichment_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      entrant_fingerprint TEXT NOT NULL,
      target_cluster_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      normalized_entity TEXT NOT NULL,
      provider_data_date TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      market TEXT NOT NULL,
      source TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (enrichment_id, snapshot_id)
    );

    CREATE INDEX IF NOT EXISTS idx_traffic_evidence_history
    ON enrichment_traffic_evidence_snapshots (
      enrichment_id,
      target_cluster_id,
      scope,
      normalized_entity,
      market,
      source,
      provider_data_date,
      observed_at
    );
  `);
}

function assertSchemaReadable(store: RunStore): boolean {
  if (!schemaExists(store)) return false;
  const version = dbOf(store)
    .prepare('SELECT version FROM traffic_evidence_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (!version || version.version !== TRAFFIC_EVIDENCE_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Unsupported traffic evidence schema version ${version?.version ?? 'missing'}; expected ${TRAFFIC_EVIDENCE_SCHEMA_VERSION}.`,
    );
  }
  return true;
}

export function loadTrafficEvidencePolicy(
  store: RunStore,
  enrichmentId: string,
): TrafficEvidencePolicy | null {
  if (!assertSchemaReadable(store)) return null;
  const row = dbOf(store)
    .prepare('SELECT policy_json FROM enrichment_traffic_evidence_policies WHERE enrichment_id = ?')
    .get(enrichmentId) as { policy_json: string } | undefined;
  if (!row) return null;
  try {
    const policy = JSON.parse(row.policy_json) as TrafficEvidencePolicy;
    validateTrafficEvidencePolicy(policy);
    return policy;
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError(
      'DB_ERROR',
      `Corrupt traffic evidence policy for enrichment ${enrichmentId}.`,
      { cause: error },
    );
  }
}

export function saveTrafficEvidencePolicy(
  store: RunStore,
  enrichmentId: string,
  policy: TrafficEvidencePolicy,
): void {
  validateTrafficEvidencePolicy(policy);
  assertCompletedEnrichment(store, enrichmentId);
  const db = dbOf(store);
  const tx = db.transaction(() => {
    applySchema(db);
    db.prepare(`
      INSERT INTO enrichment_traffic_evidence_policies (enrichment_id, policy_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(enrichment_id) DO UPDATE SET
        policy_json = excluded.policy_json,
        updated_at = excluded.updated_at
    `).run(enrichmentId, JSON.stringify(policy), new Date().toISOString());
  });
  tx();
}

export function appendTrafficSnapshots(
  store: RunStore,
  enrichmentId: string,
  snapshots: TrafficSnapshot[],
): AppendTrafficSnapshotsResult {
  if (snapshots.length === 0) return { inserted: 0, duplicates: 0 };
  assertCompletedEnrichment(store, enrichmentId);
  const entrant = loadEntrantCohortState(store, enrichmentId);
  if (!entrant) {
    throw new ResearchError(
      'DB_ERROR',
      `Traffic evidence ${enrichmentId} requires a persisted entrant-cohort snapshot.`,
    );
  }

  const canonical = normalizeTrafficSnapshots({
    rows: snapshots.map(snapshotToInput),
    cohorts: entrant.cohorts,
  });
  for (let index = 0; index < snapshots.length; index += 1) {
    if (JSON.stringify(canonical[index]) !== JSON.stringify(snapshots[index])) {
      throw new ResearchError(
        'DB_ERROR',
        `Traffic snapshot ${index + 1} is not canonical for the current entrant cohort.`,
      );
    }
  }

  const entrantFingerprint = entrantCohortFingerprint(entrant);
  const db = dbOf(store);
  let inserted = 0;
  let duplicates = 0;
  const tx = db.transaction(() => {
    applySchema(db);
    const selectExisting = db.prepare(`
      SELECT snapshot_json
      FROM enrichment_traffic_evidence_snapshots
      WHERE enrichment_id = ? AND snapshot_id = ?
    `);
    const insert = db.prepare(`
      INSERT INTO enrichment_traffic_evidence_snapshots (
        enrichment_id, snapshot_id, entrant_fingerprint, target_cluster_id,
        scope, normalized_entity, provider_data_date, observed_at,
        market, source, snapshot_json, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const importedAt = new Date().toISOString();

    for (const snapshot of snapshots) {
      const snapshotId = trafficSnapshotId(snapshot);
      const existing = selectExisting.get(enrichmentId, snapshotId) as { snapshot_json: string } | undefined;
      if (existing) {
        let persisted: TrafficSnapshot;
        try {
          persisted = JSON.parse(existing.snapshot_json) as TrafficSnapshot;
          validatePersistedSnapshot(persisted);
        } catch (error) {
          throw new ResearchError(
            'DB_ERROR',
            `Corrupt persisted traffic snapshot for ${snapshotId}.`,
            { cause: error },
          );
        }
        if (trafficSnapshotId(persisted) !== snapshotId) {
          throw new ResearchError('DB_ERROR', `Traffic snapshot hash collision/corruption for ${snapshotId}.`);
        }
        duplicates += 1;
        continue;
      }
      insert.run(
        enrichmentId,
        snapshotId,
        entrantFingerprint,
        snapshot.targetClusterId,
        snapshot.scope,
        snapshot.normalizedEntity,
        snapshot.providerDataDate,
        snapshot.observedAt,
        snapshot.market,
        snapshot.source,
        JSON.stringify(snapshot),
        importedAt,
      );
      inserted += 1;
    }
  });
  tx();
  return { inserted, duplicates };
}

export function loadTrafficImportRecords(
  store: RunStore,
  enrichmentId: string,
): TrafficImportRecord[] {
  if (!assertSchemaReadable(store)) return [];
  const rows = dbOf(store).prepare(`
    SELECT *
    FROM enrichment_traffic_evidence_snapshots
    WHERE enrichment_id = ?
    ORDER BY target_cluster_id, scope, normalized_entity, market, source,
      provider_data_date, observed_at, snapshot_id
  `).all(enrichmentId) as TrafficImportRow[];

  try {
    return rows.map((row) => {
      const snapshot = JSON.parse(row.snapshot_json) as TrafficSnapshot;
      validatePersistedSnapshot(snapshot);
      const snapshotId = trafficSnapshotId(snapshot);
      if (
        row.enrichment_id !== enrichmentId
        || row.snapshot_id !== snapshotId
        || row.target_cluster_id !== snapshot.targetClusterId
        || row.scope !== snapshot.scope
        || row.normalized_entity !== snapshot.normalizedEntity
        || row.provider_data_date !== snapshot.providerDataDate
        || row.observed_at !== snapshot.observedAt
        || row.market !== snapshot.market
        || row.source !== snapshot.source
        || !/^[a-f0-9]{64}$/.test(row.entrant_fingerprint)
        || !Number.isFinite(Date.parse(row.imported_at))
      ) {
        throw new Error(`traffic snapshot metadata mismatch for ${row.snapshot_id}`);
      }
      return {
        snapshotId,
        entrantFingerprint: row.entrant_fingerprint,
        snapshot,
        importedAt: row.imported_at,
      };
    });
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError(
      'DB_ERROR',
      `Corrupt traffic evidence snapshot for enrichment ${enrichmentId}.`,
      { cause: error },
    );
  }
}

export function trafficSnapshotId(snapshot: TrafficSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(snapshotIdentityPayload(snapshot)))
    .digest('hex');
}

function validatePersistedSnapshot(snapshot: TrafficSnapshot): void {
  projectTrafficEvidence({
    snapshots: [snapshot],
    policy: { version: TRAFFIC_EVIDENCE_VERSION, lowBaseOrganicTrafficThreshold: 0 },
  });
}

function assertCompletedEnrichment(store: RunStore, enrichmentId: string): void {
  const enrichment = store.loadEnrichmentRun(enrichmentId);
  if (!enrichment) {
    throw new ResearchError('DB_ERROR', `Traffic evidence enrichment ${enrichmentId} does not exist.`);
  }
  if (enrichment.state !== 'completed') {
    throw new ResearchError(
      'DB_ERROR',
      `Traffic evidence requires completed enrichment ${enrichmentId}; current state is ${enrichment.state}.`,
    );
  }
}

function snapshotIdentityPayload(snapshot: TrafficSnapshot): Record<string, unknown> {
  return {
    version: snapshot.version,
    targetClusterId: snapshot.targetClusterId,
    scope: snapshot.scope,
    normalizedEntity: snapshot.normalizedEntity,
    observedAt: snapshot.observedAt,
    providerDataDate: snapshot.providerDataDate,
    market: snapshot.market,
    source: snapshot.source,
    organicTraffic: snapshot.organicTraffic,
    trafficValue: snapshot.trafficValue,
    trafficValueCurrency: snapshot.trafficValueCurrency,
    provenance: snapshot.provenance,
  };
}

function snapshotToInput(snapshot: TrafficSnapshot): TrafficSnapshotInput {
  return {
    targetClusterId: snapshot.targetClusterId,
    scope: snapshot.scope,
    entity: snapshot.entity,
    observedAt: snapshot.observedAt,
    providerDataDate: snapshot.providerDataDate,
    market: snapshot.market,
    source: snapshot.source,
    organicTraffic: snapshot.organicTraffic,
    trafficValue: snapshot.trafficValue,
    trafficValueCurrency: snapshot.trafficValueCurrency,
    provenance: snapshot.provenance,
  };
}
