import Database from 'better-sqlite3';
import type { ResearchConfig } from '../config/config.js';
import {
  ENTRANT_COHORT_SERP_TOP_N,
  ENTRANT_COHORT_VERSION,
  type EntrantCohort,
} from '../enrichment/entrantCohort.js';
import { ResearchError } from '../shared/errors.js';
import type { RunStore } from './store.js';
import { loadRepresentativeQueryState } from './representativeSets.js';

export const ENTRANT_COHORT_SCHEMA_VERSION = 1;

type StoreWithDb = { db: Database.Database };

type EntrantCohortRow = {
  enrichment_id: string;
  source_run_id: string;
  representative_revision: number;
  cohort_version: string;
  serp_top_n: number;
  dr_thresholds_json: string;
  source_run_updated_at: string;
  clustering_updated_at: string;
  snapshot_json: string;
  updated_at: string;
};

export type EntrantCohortSnapshot = {
  enrichmentId: string;
  sourceRunId: string;
  representativeRevision: number;
  cohortVersion: string;
  serpTopN: number;
  drThresholds: ResearchConfig['scoring']['drThresholds'];
  sourceRunUpdatedAt: string;
  clusteringUpdatedAt: string;
  cohorts: EntrantCohort[];
};

export type EntrantCohortState = EntrantCohortSnapshot & {
  updatedAt: string;
};

export type SaveEntrantCohortResult = {
  changed: boolean;
};

function dbOf(store: RunStore): Database.Database {
  return (store as unknown as StoreWithDb).db;
}

function schemaExists(store: RunStore): boolean {
  return Boolean(dbOf(store)
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entrant_cohort_schema'")
    .get());
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entrant_cohort_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `);
  const version = db
    .prepare('SELECT version FROM entrant_cohort_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (version && version.version !== ENTRANT_COHORT_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Entrant cohort schema version ${version.version} is unsupported by this build (${ENTRANT_COHORT_SCHEMA_VERSION}).`,
    );
  }
  if (!version) {
    db.prepare('INSERT INTO entrant_cohort_schema (singleton, version) VALUES (1, ?)')
      .run(ENTRANT_COHORT_SCHEMA_VERSION);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_entrant_cohort_snapshots (
      enrichment_id TEXT PRIMARY KEY,
      source_run_id TEXT NOT NULL,
      representative_revision INTEGER NOT NULL,
      cohort_version TEXT NOT NULL,
      serp_top_n INTEGER NOT NULL,
      dr_thresholds_json TEXT NOT NULL,
      source_run_updated_at TEXT NOT NULL,
      clustering_updated_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS invalidate_entrant_cohort_on_representative_change
    AFTER UPDATE OF revision, snapshot_json ON enrichment_representative_query_runs
    WHEN OLD.snapshot_json <> NEW.snapshot_json
    BEGIN
      DELETE FROM enrichment_entrant_cohort_snapshots
      WHERE enrichment_id = NEW.enrichment_id;
    END;
  `);
}

function assertSchemaReadable(store: RunStore): boolean {
  if (!schemaExists(store)) return false;
  const version = dbOf(store)
    .prepare('SELECT version FROM entrant_cohort_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (!version || version.version !== ENTRANT_COHORT_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Unsupported entrant cohort schema version ${version?.version ?? 'missing'}; expected ${ENTRANT_COHORT_SCHEMA_VERSION}.`,
    );
  }
  return true;
}

export function saveEntrantCohortSnapshot(
  store: RunStore,
  snapshot: EntrantCohortSnapshot,
): SaveEntrantCohortResult {
  validateSnapshot(snapshot);
  assertRepresentativeParent(store, snapshot);
  const normalized = normalizeSnapshot(snapshot);
  const serialized = JSON.stringify(normalized);
  const db = dbOf(store);
  let changed = true;

  const tx = db.transaction(() => {
    applySchema(db);
    const existing = db
      .prepare('SELECT snapshot_json FROM enrichment_entrant_cohort_snapshots WHERE enrichment_id = ?')
      .get(snapshot.enrichmentId) as { snapshot_json: string } | undefined;
    changed = existing?.snapshot_json !== serialized;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO enrichment_entrant_cohort_snapshots (
        enrichment_id, source_run_id, representative_revision, cohort_version,
        serp_top_n, dr_thresholds_json, source_run_updated_at,
        clustering_updated_at, snapshot_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(enrichment_id) DO UPDATE SET
        source_run_id = excluded.source_run_id,
        representative_revision = excluded.representative_revision,
        cohort_version = excluded.cohort_version,
        serp_top_n = excluded.serp_top_n,
        dr_thresholds_json = excluded.dr_thresholds_json,
        source_run_updated_at = excluded.source_run_updated_at,
        clustering_updated_at = excluded.clustering_updated_at,
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `).run(
      normalized.enrichmentId,
      normalized.sourceRunId,
      normalized.representativeRevision,
      normalized.cohortVersion,
      normalized.serpTopN,
      JSON.stringify(normalized.drThresholds),
      normalized.sourceRunUpdatedAt,
      normalized.clusteringUpdatedAt,
      serialized,
      now,
    );
  });
  tx();
  return { changed };
}

export function loadEntrantCohortState(
  store: RunStore,
  enrichmentId: string,
): EntrantCohortState | null {
  if (!assertSchemaReadable(store)) return null;
  const row = dbOf(store)
    .prepare('SELECT * FROM enrichment_entrant_cohort_snapshots WHERE enrichment_id = ?')
    .get(enrichmentId) as EntrantCohortRow | undefined;
  if (!row) return null;

  try {
    const snapshot = JSON.parse(row.snapshot_json) as EntrantCohortSnapshot;
    validateSnapshot(snapshot);
    const normalized = normalizeSnapshot(snapshot);
    if (
      normalized.enrichmentId !== row.enrichment_id
      || normalized.sourceRunId !== row.source_run_id
      || normalized.representativeRevision !== row.representative_revision
      || normalized.cohortVersion !== row.cohort_version
      || normalized.serpTopN !== row.serp_top_n
      || JSON.stringify(normalized.drThresholds) !== row.dr_thresholds_json
      || normalized.sourceRunUpdatedAt !== row.source_run_updated_at
      || normalized.clusteringUpdatedAt !== row.clustering_updated_at
      || JSON.stringify(normalized) !== row.snapshot_json
    ) {
      throw new Error('entrant cohort snapshot metadata mismatch');
    }
    return { ...normalized, updatedAt: row.updated_at };
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError(
      'DB_ERROR',
      `Corrupt entrant cohort snapshot for enrichment ${enrichmentId}.`,
      { cause: error },
    );
  }
}

function assertRepresentativeParent(
  store: RunStore,
  snapshot: EntrantCohortSnapshot,
): void {
  const enrichment = store.loadEnrichmentRun(snapshot.enrichmentId);
  if (!enrichment) {
    throw new ResearchError('DB_ERROR', `Entrant cohort enrichment ${snapshot.enrichmentId} does not exist.`);
  }
  if (enrichment.sourceRunId !== snapshot.sourceRunId) {
    throw new ResearchError(
      'DB_ERROR',
      `Entrant cohort source run ${snapshot.sourceRunId} does not match enrichment source ${enrichment.sourceRunId}.`,
    );
  }

  const parent = loadRepresentativeQueryState(store, snapshot.enrichmentId);
  if (!parent) {
    throw new ResearchError(
      'DB_ERROR',
      `Entrant cohort ${snapshot.enrichmentId} requires a persisted representative-query snapshot.`,
    );
  }
  if (parent.revision !== snapshot.representativeRevision) {
    throw new ResearchError(
      'DB_ERROR',
      `Entrant cohort representative revision ${snapshot.representativeRevision} does not match current revision ${parent.revision}.`,
    );
  }
  if (parent.sets.length !== snapshot.cohorts.length) {
    throw new ResearchError(
      'DB_ERROR',
      `Entrant cohort has ${snapshot.cohorts.length} finalist cluster(s) but representative revision ${parent.revision} has ${parent.sets.length}.`,
    );
  }
  const parentByCluster = new Map(parent.sets.map((set) => [set.clusterId, set]));
  for (const cohort of snapshot.cohorts) {
    const representativeSet = parentByCluster.get(cohort.clusterId);
    if (!representativeSet) {
      throw new ResearchError(
        'DB_ERROR',
        `Entrant cohort cluster ${cohort.clusterId} is absent from representative revision ${parent.revision}.`,
      );
    }
    if (!sameNumberArray(representativeSet.representativeKeywordIds, cohort.representativeKeywordIds)) {
      throw new ResearchError(
        'DB_ERROR',
        `Entrant cohort ${cohort.clusterId} keyword ids do not match representative revision ${parent.revision}.`,
      );
    }
  }
}

function validateSnapshot(snapshot: EntrantCohortSnapshot): void {
  if (snapshot.enrichmentId.trim() === '' || snapshot.sourceRunId.trim() === '') {
    throw new ResearchError('DB_ERROR', 'Entrant cohort snapshot requires enrichment and source run ids.');
  }
  if (!Number.isInteger(snapshot.representativeRevision) || snapshot.representativeRevision < 1) {
    throw new ResearchError('DB_ERROR', 'Entrant cohort snapshot has invalid representative revision.');
  }
  if (snapshot.cohortVersion !== ENTRANT_COHORT_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Entrant cohort version ${snapshot.cohortVersion} is unsupported; expected ${ENTRANT_COHORT_VERSION}.`,
    );
  }
  if (snapshot.serpTopN !== ENTRANT_COHORT_SERP_TOP_N) {
    throw new ResearchError(
      'DB_ERROR',
      `Entrant cohort top-N ${snapshot.serpTopN} is unsupported; expected ${ENTRANT_COHORT_SERP_TOP_N}.`,
    );
  }
  validateDrThresholds(snapshot.drThresholds);
  if (!Number.isFinite(Date.parse(snapshot.sourceRunUpdatedAt))) {
    throw new ResearchError('DB_ERROR', 'Entrant cohort snapshot has invalid source run timestamp.');
  }
  if (!Number.isFinite(Date.parse(snapshot.clusteringUpdatedAt))) {
    throw new ResearchError('DB_ERROR', 'Entrant cohort snapshot has invalid clustering timestamp.');
  }
  if (snapshot.cohorts.length === 0) {
    throw new ResearchError('DB_ERROR', 'Entrant cohort snapshot requires at least one finalist cohort.');
  }

  const clusterIds = new Set<string>();
  for (const cohort of snapshot.cohorts) {
    if (clusterIds.has(cohort.clusterId)) {
      throw new ResearchError('DB_ERROR', `Duplicate entrant cohort cluster ${cohort.clusterId}.`);
    }
    clusterIds.add(cohort.clusterId);
    validateCohort(snapshot, cohort);
  }
}

function validateCohort(snapshot: EntrantCohortSnapshot, cohort: EntrantCohort): void {
  if (cohort.version !== snapshot.cohortVersion || cohort.serpTopN !== snapshot.serpTopN) {
    throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} version/top-N does not match snapshot metadata.`);
  }
  if (
    cohort.representativeKeywordIds.length !== cohort.representativeQueryCount
    || new Set(cohort.representativeKeywordIds).size !== cohort.representativeKeywordIds.length
  ) {
    throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} representative denominator is inconsistent.`);
  }
  if (cohort.domains.length !== cohort.summary.uniqueDomainCount) {
    throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} unique-domain count is inconsistent.`);
  }
  if (cohort.occurrences.length !== cohort.summary.observedOccurrenceCount) {
    throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} occurrence count is inconsistent.`);
  }
  if (cohort.excludedOccurrences.length !== cohort.summary.excludedOccurrenceCount) {
    throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} excluded occurrence count is inconsistent.`);
  }

  const domainNames = new Set<string>();
  let domainOccurrenceCount = 0;
  let normalizedOccurrenceCount = 0;
  let knownDrDomainCount = 0;
  let missingDrDomainCount = 0;
  let conflictingDrDomainCount = 0;
  let weakDomainCount = 0;
  let repeatedDomainCount = 0;
  let samePageRepeatedDomainCount = 0;
  let differentPageRepeatedDomainCount = 0;

  for (const domain of cohort.domains) {
    if (domainNames.has(domain.registrableDomain)) {
      throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} contains duplicate domain ${domain.registrableDomain}.`);
    }
    domainNames.add(domain.registrableDomain);
    if (domain.occurrenceCount !== domain.occurrences.length) {
      throw new ResearchError('DB_ERROR', `Entrant domain ${domain.registrableDomain} occurrence count is inconsistent.`);
    }
    domainOccurrenceCount += domain.occurrenceCount;

    const queryIds = [...new Set(domain.occurrences.map((row) => row.keywordIdx))].sort((a, b) => a - b);
    if (!sameNumberArray(queryIds, domain.queryIdsPresent)) {
      throw new ResearchError('DB_ERROR', `Entrant domain ${domain.registrableDomain} query ids are inconsistent.`);
    }
    assertRatio(
      `Entrant domain ${domain.registrableDomain} query coverage`,
      domain.queryCoverage,
      queryIds.length,
      cohort.representativeQueryCount,
    );

    const domainNormalizedCount = domain.occurrences.filter(
      (row) => row.normalizedPageIdentity !== null,
    ).length;
    normalizedOccurrenceCount += domainNormalizedCount;
    assertRatio(
      `Entrant domain ${domain.registrableDomain} page identity coverage`,
      domain.pageIdentityCoverage,
      domainNormalizedCount,
      domain.occurrenceCount,
    );

    const knownOccurrenceCount = domain.occurrences.filter((row) => row.dr !== null).length;
    if (
      domain.drEvidence.occurrenceCount !== domain.occurrenceCount
      || domain.drEvidence.knownOccurrenceCount !== knownOccurrenceCount
    ) {
      throw new ResearchError('DB_ERROR', `Entrant domain ${domain.registrableDomain} DR occurrence coverage is inconsistent.`);
    }

    if (domain.drEvidence.status === 'known') knownDrDomainCount += 1;
    else if (domain.drEvidence.status === 'missing') missingDrDomainCount += 1;
    else conflictingDrDomainCount += 1;
    if (domain.drEvidence.isWeak === true) weakDomainCount += 1;
    if (domain.queryCoverage.numerator >= 2) repeatedDomainCount += 1;
    if (domain.samePageRepetition.repeatedAcrossQueries) samePageRepeatedDomainCount += 1;
    if (domain.sameDomainDifferentPageRepetition.repeatedAcrossQueries) differentPageRepeatedDomainCount += 1;
  }

  if (domainOccurrenceCount !== cohort.occurrences.length) {
    throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} domain occurrence projection is inconsistent.`);
  }
  assertRatio(
    `Entrant cohort ${cohort.clusterId} page identity coverage`,
    cohort.summary.pageIdentityCoverage,
    normalizedOccurrenceCount,
    cohort.occurrences.length,
  );
  if (
    cohort.summary.knownDrDomainCount !== knownDrDomainCount
    || cohort.summary.missingDrDomainCount !== missingDrDomainCount
    || cohort.summary.conflictingDrDomainCount !== conflictingDrDomainCount
  ) {
    throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} DR domain counts are inconsistent.`);
  }
  if (cohort.summary.weakDomainCount !== weakDomainCount) {
    throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} weak-domain count is inconsistent.`);
  }
  assertRatio(
    `Entrant cohort ${cohort.clusterId} weak-domain coverage`,
    cohort.summary.weakDomainCoverage,
    weakDomainCount,
    knownDrDomainCount,
  );
  if (cohort.summary.repeatedDomainCount !== repeatedDomainCount) {
    throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} repeated-domain count is inconsistent.`);
  }
  assertRatio(
    `Entrant cohort ${cohort.clusterId} repeated-domain coverage`,
    cohort.summary.repeatedDomainCoverage,
    repeatedDomainCount,
    cohort.domains.length,
  );
  if (
    cohort.summary.samePageRepeatedDomainCount !== samePageRepeatedDomainCount
    || cohort.summary.differentPageRepeatedDomainCount !== differentPageRepeatedDomainCount
  ) {
    throw new ResearchError('DB_ERROR', `Entrant cohort ${cohort.clusterId} page-repetition counts are inconsistent.`);
  }
}

function validateDrThresholds(thresholds: ResearchConfig['scoring']['drThresholds']): void {
  if (
    !Number.isFinite(thresholds.veryWeakMax)
    || !Number.isFinite(thresholds.weakMax)
    || !Number.isFinite(thresholds.strongMin)
    || !Number.isFinite(thresholds.strongMax)
    || thresholds.veryWeakMax < 0
    || thresholds.weakMax <= thresholds.veryWeakMax
    || thresholds.strongMin < thresholds.weakMax
    || thresholds.strongMax <= thresholds.strongMin
  ) {
    throw new ResearchError('DB_ERROR', 'Entrant cohort snapshot has invalid DR thresholds.');
  }
}

function assertRatio(
  label: string,
  actual: { numerator: number; denominator: number; ratio: number | null },
  numerator: number,
  denominator: number,
): void {
  const expectedRatio = denominator === 0 ? null : numerator / denominator;
  if (
    actual.numerator !== numerator
    || actual.denominator !== denominator
    || actual.ratio !== expectedRatio
  ) {
    throw new ResearchError('DB_ERROR', `${label} is inconsistent.`);
  }
}

function normalizeSnapshot(snapshot: EntrantCohortSnapshot): EntrantCohortSnapshot {
  return {
    ...snapshot,
    drThresholds: { ...snapshot.drThresholds },
    cohorts: [...snapshot.cohorts].sort((a, b) => compareClusterIds(a.clusterId, b.clusterId)),
  };
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
  return a.localeCompare(b);
}
