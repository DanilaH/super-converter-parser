import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { RunStore } from './store.js';
import { loadEntrantCohortState, type EntrantCohortState } from './entrantCohorts.js';
import type { HistoricalPresenceConfigSnapshot } from '../historicalPresence/types.js';
import {
  COHORT_HISTORICAL_PRESENCE_VERSION,
  type CohortHistoricalPresenceCollection,
} from '../historicalPresence/cohortCollector.js';
import { ResearchError } from '../shared/errors.js';

export const COHORT_HISTORICAL_PRESENCE_SCHEMA_VERSION = 1;

type StoreWithDb = { db: Database.Database };

type SnapshotRow = {
  enrichment_id: string;
  source_run_id: string;
  entrant_representative_revision: number;
  entrant_fingerprint: string;
  collection_version: string;
  config_json: string;
  snapshot_json: string;
  updated_at: string;
};

export type CohortHistoricalPresenceSnapshot = {
  enrichmentId: string;
  sourceRunId: string;
  entrantRepresentativeRevision: number;
  entrantFingerprint: string;
  collectionVersion: string;
  config: HistoricalPresenceConfigSnapshot & { domainCap: number };
  collection: CohortHistoricalPresenceCollection;
};

export type CohortHistoricalPresenceState = CohortHistoricalPresenceSnapshot & {
  updatedAt: string;
};

function dbOf(store: RunStore): Database.Database {
  return (store as unknown as StoreWithDb).db;
}

function schemaExists(store: RunStore): boolean {
  return Boolean(dbOf(store)
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cohort_historical_presence_schema'")
    .get());
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cohort_historical_presence_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `);
  const version = db
    .prepare('SELECT version FROM cohort_historical_presence_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (version && version.version !== COHORT_HISTORICAL_PRESENCE_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Cohort historical-presence schema version ${version.version} is unsupported by this build (${COHORT_HISTORICAL_PRESENCE_SCHEMA_VERSION}).`,
    );
  }
  if (!version) {
    db.prepare('INSERT INTO cohort_historical_presence_schema (singleton, version) VALUES (1, ?)')
      .run(COHORT_HISTORICAL_PRESENCE_SCHEMA_VERSION);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_cohort_historical_presence_snapshots (
      enrichment_id TEXT PRIMARY KEY,
      source_run_id TEXT NOT NULL,
      entrant_representative_revision INTEGER NOT NULL,
      entrant_fingerprint TEXT NOT NULL,
      collection_version TEXT NOT NULL,
      config_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS invalidate_cohort_historical_presence_on_entrant_change
    AFTER UPDATE OF snapshot_json ON enrichment_entrant_cohort_snapshots
    WHEN OLD.snapshot_json <> NEW.snapshot_json
    BEGIN
      DELETE FROM enrichment_cohort_historical_presence_snapshots
      WHERE enrichment_id = NEW.enrichment_id;
    END;

    CREATE TRIGGER IF NOT EXISTS invalidate_cohort_historical_presence_on_entrant_delete
    AFTER DELETE ON enrichment_entrant_cohort_snapshots
    BEGIN
      DELETE FROM enrichment_cohort_historical_presence_snapshots
      WHERE enrichment_id = OLD.enrichment_id;
    END;
  `);
}

function assertSchemaReadable(store: RunStore): boolean {
  if (!schemaExists(store)) return false;
  const version = dbOf(store)
    .prepare('SELECT version FROM cohort_historical_presence_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (!version || version.version !== COHORT_HISTORICAL_PRESENCE_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Unsupported cohort historical-presence schema version ${version?.version ?? 'missing'}; expected ${COHORT_HISTORICAL_PRESENCE_SCHEMA_VERSION}.`,
    );
  }
  return true;
}

export function entrantHistoricalPresenceFingerprint(state: EntrantCohortState): string {
  const payload = {
    enrichmentId: state.enrichmentId,
    sourceRunId: state.sourceRunId,
    representativeRevision: state.representativeRevision,
    cohortVersion: state.cohortVersion,
    serpTopN: state.serpTopN,
    drThresholds: { ...state.drThresholds },
    sourceRunUpdatedAt: state.sourceRunUpdatedAt,
    clusteringUpdatedAt: state.clusteringUpdatedAt,
    cohorts: state.cohorts,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function saveCohortHistoricalPresenceSnapshot(
  store: RunStore,
  snapshot: CohortHistoricalPresenceSnapshot,
): { changed: boolean } {
  const parent = assertParent(store, snapshot);
  validateSnapshot(snapshot, parent);
  const normalized = normalizeSnapshot(snapshot);
  const serialized = JSON.stringify(normalized);
  const db = dbOf(store);
  let changed = true;
  const tx = db.transaction(() => {
    applySchema(db);
    const previous = db
      .prepare('SELECT snapshot_json FROM enrichment_cohort_historical_presence_snapshots WHERE enrichment_id = ?')
      .get(snapshot.enrichmentId) as { snapshot_json: string } | undefined;
    changed = previous?.snapshot_json !== serialized;
    const updatedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO enrichment_cohort_historical_presence_snapshots (
        enrichment_id, source_run_id, entrant_representative_revision,
        entrant_fingerprint, collection_version, config_json, snapshot_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(enrichment_id) DO UPDATE SET
        source_run_id = excluded.source_run_id,
        entrant_representative_revision = excluded.entrant_representative_revision,
        entrant_fingerprint = excluded.entrant_fingerprint,
        collection_version = excluded.collection_version,
        config_json = excluded.config_json,
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `).run(
      normalized.enrichmentId,
      normalized.sourceRunId,
      normalized.entrantRepresentativeRevision,
      normalized.entrantFingerprint,
      normalized.collectionVersion,
      JSON.stringify(normalized.config),
      serialized,
      updatedAt,
    );
  });
  tx();
  return { changed };
}

export function loadCohortHistoricalPresenceState(
  store: RunStore,
  enrichmentId: string,
): CohortHistoricalPresenceState | null {
  if (!assertSchemaReadable(store)) return null;
  const row = dbOf(store)
    .prepare('SELECT * FROM enrichment_cohort_historical_presence_snapshots WHERE enrichment_id = ?')
    .get(enrichmentId) as SnapshotRow | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.snapshot_json) as CohortHistoricalPresenceSnapshot;
    const parent = assertParent(store, parsed);
    validateSnapshot(parsed, parent);
    const normalized = normalizeSnapshot(parsed);
    if (
      normalized.enrichmentId !== row.enrichment_id
      || normalized.sourceRunId !== row.source_run_id
      || normalized.entrantRepresentativeRevision !== row.entrant_representative_revision
      || normalized.entrantFingerprint !== row.entrant_fingerprint
      || normalized.collectionVersion !== row.collection_version
      || JSON.stringify(normalized.config) !== row.config_json
      || JSON.stringify(normalized) !== row.snapshot_json
    ) {
      throw new Error('cohort historical-presence snapshot metadata mismatch');
    }
    return { ...normalized, updatedAt: row.updated_at };
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError(
      'DB_ERROR',
      `Corrupt cohort historical-presence snapshot for enrichment ${enrichmentId}.`,
      { cause: error },
    );
  }
}

function assertParent(
  store: RunStore,
  snapshot: Pick<CohortHistoricalPresenceSnapshot, 'enrichmentId' | 'sourceRunId' | 'entrantRepresentativeRevision' | 'entrantFingerprint'>,
): EntrantCohortState {
  const parent = loadEntrantCohortState(store, snapshot.enrichmentId);
  if (!parent) {
    throw new ResearchError('DB_ERROR', `Historical presence ${snapshot.enrichmentId} requires a persisted entrant-cohort snapshot.`);
  }
  if (parent.sourceRunId !== snapshot.sourceRunId) {
    throw new ResearchError('DB_ERROR', 'Historical-presence source run does not match entrant-cohort parent.');
  }
  if (parent.representativeRevision !== snapshot.entrantRepresentativeRevision) {
    throw new ResearchError('DB_ERROR', 'Historical-presence representative revision does not match entrant-cohort parent.');
  }
  if (entrantHistoricalPresenceFingerprint(parent) !== snapshot.entrantFingerprint) {
    throw new ResearchError('DB_ERROR', 'Historical-presence entrant fingerprint does not match current parent snapshot.');
  }
  return parent;
}

function validateSnapshot(snapshot: CohortHistoricalPresenceSnapshot, parent: EntrantCohortState): void {
  if (snapshot.collectionVersion !== COHORT_HISTORICAL_PRESENCE_VERSION) {
    throw new ResearchError('DB_ERROR', `Unsupported cohort historical-presence version ${snapshot.collectionVersion}.`);
  }
  if (snapshot.collection.version !== snapshot.collectionVersion) {
    throw new ResearchError('DB_ERROR', 'Historical-presence collection version mismatch.');
  }
  if (snapshot.collection.domainCap !== snapshot.config.domainCap) {
    throw new ResearchError('DB_ERROR', 'Historical-presence collection cap does not match persisted config.');
  }
  if (snapshot.config.provider !== 'common_crawl' || snapshot.config.queryVersion < 1) {
    throw new ResearchError('DB_ERROR', 'Historical-presence snapshot has unsupported provider/query identity.');
  }

  const expectedDomains = [...new Set(parent.cohorts.flatMap((cohort) => cohort.domains.map((domain) => domain.registrableDomain)))].sort();
  const actualDomains = snapshot.collection.domains.map((domain) => domain.registrableDomain).sort();
  if (expectedDomains.length !== actualDomains.length || expectedDomains.some((domain, index) => domain !== actualDomains[index])) {
    throw new ResearchError('DB_ERROR', 'Historical-presence domains do not match entrant-cohort parent.');
  }

  let checked = 0;
  let omitted = 0;
  let known = 0;
  let notFound = 0;
  let unavailable = 0;
  let errors = 0;
  let complete = 0;
  let cacheHits = 0;
  let networkRequests = 0;
  const statusCounts: Record<string, number> = {};
  for (const domain of snapshot.collection.domains) {
    if (domain.coverageStatus === 'omitted') {
      omitted += 1;
      if (domain.omitReason !== 'domain_cap' || domain.result !== null || domain.cacheStatus !== 'omitted') {
        throw new ResearchError('DB_ERROR', `Invalid omitted historical-presence row for ${domain.registrableDomain}.`);
      }
      continue;
    }
    checked += 1;
    if (domain.omitReason !== null || domain.result === null || domain.result.domain !== domain.registrableDomain) {
      throw new ResearchError('DB_ERROR', `Invalid checked historical-presence row for ${domain.registrableDomain}.`);
    }
    if (domain.result.source !== snapshot.config.provider) {
      throw new ResearchError('DB_ERROR', `Historical-presence provider mismatch for ${domain.registrableDomain}.`);
    }
    statusCounts[domain.result.status] = (statusCounts[domain.result.status] ?? 0) + 1;
    if (domain.result.status === 'ok') known += 1;
    else if (domain.result.status === 'not_found') notFound += 1;
    else if (domain.result.status === 'unavailable') unavailable += 1;
    else if (domain.result.status === 'error') errors += 1;
    if (domain.result.status === 'ok' && domain.result.historyCompleteForSelectedCollections) complete += 1;
    if (domain.cacheStatus === 'hit') cacheHits += 1;
    else networkRequests += domain.result.requestCount;
  }

  const summary = snapshot.collection.summary;
  const expected = {
    uniqueDomainCount: expectedDomains.length,
    checkedDomainCount: checked,
    omittedDomainCount: omitted,
    knownPresenceDomainCount: known,
    notFoundDomainCount: notFound,
    unavailableDomainCount: unavailable,
    errorDomainCount: errors,
    completeSelectedHistoryDomainCount: complete,
    cacheHitCount: cacheHits,
    networkRequestCount: networkRequests,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (summary[field as keyof typeof expected] !== value) {
      throw new ResearchError('DB_ERROR', `Historical-presence summary ${field} does not match domain rows.`);
    }
  }
  if (JSON.stringify(sortedCounts(summary.statusCounts)) !== JSON.stringify(sortedCounts(statusCounts))) {
    throw new ResearchError('DB_ERROR', 'Historical-presence status counts do not match domain rows.');
  }
}

function normalizeSnapshot(snapshot: CohortHistoricalPresenceSnapshot): CohortHistoricalPresenceSnapshot {
  return {
    ...snapshot,
    config: { ...snapshot.config },
    collection: {
      ...snapshot.collection,
      domains: [...snapshot.collection.domains].sort((a, b) => a.registrableDomain.localeCompare(b.registrableDomain)),
      summary: {
        ...snapshot.collection.summary,
        statusCounts: sortedCounts(snapshot.collection.summary.statusCounts),
      },
    },
  };
}

function sortedCounts(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
