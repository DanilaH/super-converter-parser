import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  COHORT_HISTORY_PROJECTION_VERSION,
  type CohortHistoryPolicy,
  type CohortHistoryProjection,
} from '../enrichment/cohortHistory.js';
import { ResearchError } from '../shared/errors.js';
import {
  loadEntrantCohortState,
  type EntrantCohortSnapshot,
  type EntrantCohortState,
} from './entrantCohorts.js';
import type { RunStore } from './store.js';

export const COHORT_HISTORY_SCHEMA_VERSION = 1;

type StoreWithDb = { db: Database.Database };

type CohortHistoryRow = {
  enrichment_id: string;
  source_run_id: string;
  entrant_representative_revision: number;
  entrant_fingerprint: string;
  projection_version: string;
  policy_json: string;
  snapshot_json: string;
  updated_at: string;
};

export type CohortHistorySnapshot = {
  enrichmentId: string;
  sourceRunId: string;
  entrantRepresentativeRevision: number;
  entrantFingerprint: string;
  projectionVersion: string;
  policy: CohortHistoryPolicy;
  projections: CohortHistoryProjection[];
};

export type CohortHistoryState = CohortHistorySnapshot & {
  updatedAt: string;
};

export type SaveCohortHistoryResult = {
  changed: boolean;
};

function dbOf(store: RunStore): Database.Database {
  return (store as unknown as StoreWithDb).db;
}

function schemaExists(store: RunStore): boolean {
  return Boolean(dbOf(store)
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cohort_history_schema'")
    .get());
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cohort_history_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `);
  const version = db
    .prepare('SELECT version FROM cohort_history_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (version && version.version !== COHORT_HISTORY_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Cohort history schema version ${version.version} is unsupported by this build (${COHORT_HISTORY_SCHEMA_VERSION}).`,
    );
  }
  if (!version) {
    db.prepare('INSERT INTO cohort_history_schema (singleton, version) VALUES (1, ?)')
      .run(COHORT_HISTORY_SCHEMA_VERSION);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_cohort_history_configs (
      enrichment_id TEXT PRIMARY KEY,
      policy_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS enrichment_cohort_history_snapshots (
      enrichment_id TEXT PRIMARY KEY,
      source_run_id TEXT NOT NULL,
      entrant_representative_revision INTEGER NOT NULL,
      entrant_fingerprint TEXT NOT NULL,
      projection_version TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS invalidate_cohort_history_on_entrant_change
    AFTER UPDATE OF snapshot_json ON enrichment_entrant_cohort_snapshots
    WHEN OLD.snapshot_json <> NEW.snapshot_json
    BEGIN
      DELETE FROM enrichment_cohort_history_snapshots
      WHERE enrichment_id = NEW.enrichment_id;
    END;

    CREATE TRIGGER IF NOT EXISTS invalidate_cohort_history_on_entrant_delete
    AFTER DELETE ON enrichment_entrant_cohort_snapshots
    BEGIN
      DELETE FROM enrichment_cohort_history_snapshots
      WHERE enrichment_id = OLD.enrichment_id;
    END;

    CREATE TRIGGER IF NOT EXISTS invalidate_cohort_history_on_domain_age_insert
    AFTER INSERT ON enrichment_items
    WHEN NEW.module = 'domain_age'
    BEGIN
      DELETE FROM enrichment_cohort_history_snapshots
      WHERE enrichment_id = NEW.enrichment_id;
    END;

    CREATE TRIGGER IF NOT EXISTS invalidate_cohort_history_on_domain_age_update
    AFTER UPDATE ON enrichment_items
    WHEN
      (NEW.module = 'domain_age' OR OLD.module = 'domain_age')
      AND (
        NEW.module IS NOT OLD.module
        OR NEW.status IS NOT OLD.status
        OR NEW.payload IS NOT OLD.payload
      )
    BEGIN
      DELETE FROM enrichment_cohort_history_snapshots
      WHERE enrichment_id = NEW.enrichment_id OR enrichment_id = OLD.enrichment_id;
    END;

    CREATE TRIGGER IF NOT EXISTS invalidate_cohort_history_on_domain_age_delete
    AFTER DELETE ON enrichment_items
    WHEN OLD.module = 'domain_age'
    BEGIN
      DELETE FROM enrichment_cohort_history_snapshots
      WHERE enrichment_id = OLD.enrichment_id;
    END;
  `);
}

function assertSchemaReadable(store: RunStore): boolean {
  if (!schemaExists(store)) return false;
  const version = dbOf(store)
    .prepare('SELECT version FROM cohort_history_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (!version || version.version !== COHORT_HISTORY_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Unsupported cohort history schema version ${version?.version ?? 'missing'}; expected ${COHORT_HISTORY_SCHEMA_VERSION}.`,
    );
  }
  return true;
}

export function entrantCohortFingerprint(state: EntrantCohortState | EntrantCohortSnapshot): string {
  const snapshot: EntrantCohortSnapshot = {
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
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function loadCohortHistoryPolicy(
  store: RunStore,
  enrichmentId: string,
): CohortHistoryPolicy | null {
  if (!assertSchemaReadable(store)) return null;
  const row = dbOf(store)
    .prepare('SELECT policy_json FROM enrichment_cohort_history_configs WHERE enrichment_id = ?')
    .get(enrichmentId) as { policy_json: string } | undefined;
  if (!row) return null;
  try {
    const policy = JSON.parse(row.policy_json) as CohortHistoryPolicy;
    validatePolicy(policy);
    return policy;
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError('DB_ERROR', `Corrupt cohort history policy for enrichment ${enrichmentId}.`, { cause: error });
  }
}

export function saveCohortHistorySnapshot(
  store: RunStore,
  snapshot: CohortHistorySnapshot,
): SaveCohortHistoryResult {
  validateSnapshot(snapshot);
  const parent = assertEntrantParent(store, snapshot);
  validateProjectionParent(parent, snapshot.projections);
  const normalized = normalizeSnapshot(snapshot);
  const serialized = JSON.stringify(normalized);
  const db = dbOf(store);
  let changed = true;

  const tx = db.transaction(() => {
    applySchema(db);
    const previous = db
      .prepare('SELECT snapshot_json FROM enrichment_cohort_history_snapshots WHERE enrichment_id = ?')
      .get(snapshot.enrichmentId) as { snapshot_json: string } | undefined;
    changed = previous?.snapshot_json !== serialized;
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO enrichment_cohort_history_configs (enrichment_id, policy_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(enrichment_id) DO UPDATE SET
        policy_json = excluded.policy_json,
        updated_at = excluded.updated_at
    `).run(normalized.enrichmentId, JSON.stringify(normalized.policy), now);

    db.prepare(`
      INSERT INTO enrichment_cohort_history_snapshots (
        enrichment_id, source_run_id, entrant_representative_revision,
        entrant_fingerprint, projection_version, policy_json, snapshot_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(enrichment_id) DO UPDATE SET
        source_run_id = excluded.source_run_id,
        entrant_representative_revision = excluded.entrant_representative_revision,
        entrant_fingerprint = excluded.entrant_fingerprint,
        projection_version = excluded.projection_version,
        policy_json = excluded.policy_json,
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `).run(
      normalized.enrichmentId,
      normalized.sourceRunId,
      normalized.entrantRepresentativeRevision,
      normalized.entrantFingerprint,
      normalized.projectionVersion,
      JSON.stringify(normalized.policy),
      serialized,
      now,
    );
  });
  tx();
  return { changed };
}

export function loadCohortHistoryState(
  store: RunStore,
  enrichmentId: string,
): CohortHistoryState | null {
  if (!assertSchemaReadable(store)) return null;
  const row = dbOf(store)
    .prepare('SELECT * FROM enrichment_cohort_history_snapshots WHERE enrichment_id = ?')
    .get(enrichmentId) as CohortHistoryRow | undefined;
  if (!row) return null;

  try {
    const snapshot = JSON.parse(row.snapshot_json) as CohortHistorySnapshot;
    validateSnapshot(snapshot);
    const normalized = normalizeSnapshot(snapshot);
    const parent = assertEntrantParent(store, normalized);
    validateProjectionParent(parent, normalized.projections);
    if (
      normalized.enrichmentId !== row.enrichment_id
      || normalized.sourceRunId !== row.source_run_id
      || normalized.entrantRepresentativeRevision !== row.entrant_representative_revision
      || normalized.entrantFingerprint !== row.entrant_fingerprint
      || normalized.projectionVersion !== row.projection_version
      || JSON.stringify(normalized.policy) !== row.policy_json
      || JSON.stringify(normalized) !== row.snapshot_json
    ) {
      throw new Error('cohort history snapshot metadata mismatch');
    }
    return { ...normalized, updatedAt: row.updated_at };
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError('DB_ERROR', `Corrupt cohort history snapshot for enrichment ${enrichmentId}.`, { cause: error });
  }
}

function assertEntrantParent(
  store: RunStore,
  snapshot: CohortHistorySnapshot,
): EntrantCohortState {
  const parent = loadEntrantCohortState(store, snapshot.enrichmentId);
  if (!parent) {
    throw new ResearchError(
      'DB_ERROR',
      `Cohort history ${snapshot.enrichmentId} requires a persisted entrant-cohort snapshot.`,
    );
  }
  if (parent.sourceRunId !== snapshot.sourceRunId) {
    throw new ResearchError('DB_ERROR', 'Cohort history source run does not match entrant-cohort parent.');
  }
  if (parent.representativeRevision !== snapshot.entrantRepresentativeRevision) {
    throw new ResearchError('DB_ERROR', 'Cohort history representative revision does not match entrant-cohort parent.');
  }
  const fingerprint = entrantCohortFingerprint(parent);
  if (fingerprint !== snapshot.entrantFingerprint) {
    throw new ResearchError('DB_ERROR', 'Cohort history entrant fingerprint does not match current parent snapshot.');
  }
  return parent;
}

function validateProjectionParent(
  parent: EntrantCohortState,
  projections: CohortHistoryProjection[],
): void {
  if (parent.cohorts.length !== projections.length) {
    throw new ResearchError('DB_ERROR', 'Cohort history cluster count does not match entrant parent.');
  }
  const projectionByCluster = new Map(projections.map((projection) => [projection.clusterId, projection]));
  for (const cohort of parent.cohorts) {
    const projection = projectionByCluster.get(cohort.clusterId);
    if (!projection) {
      throw new ResearchError('DB_ERROR', `Missing cohort history projection for ${cohort.clusterId}.`);
    }
    const parentDomains = cohort.domains.map((domain) => domain.registrableDomain).sort();
    const projectionDomains = projection.domains.map((domain) => domain.registrableDomain).sort();
    if (
      parentDomains.length !== projectionDomains.length
      || parentDomains.some((domain, index) => domain !== projectionDomains[index])
    ) {
      throw new ResearchError('DB_ERROR', `Cohort history domains do not match entrant parent for ${cohort.clusterId}.`);
    }
  }
}

function validateSnapshot(snapshot: CohortHistorySnapshot): void {
  if (snapshot.enrichmentId.trim() === '' || snapshot.sourceRunId.trim() === '') {
    throw new ResearchError('DB_ERROR', 'Cohort history snapshot requires enrichment and source run ids.');
  }
  if (!Number.isInteger(snapshot.entrantRepresentativeRevision) || snapshot.entrantRepresentativeRevision < 1) {
    throw new ResearchError('DB_ERROR', 'Cohort history snapshot has invalid representative revision.');
  }
  if (!/^[a-f0-9]{64}$/.test(snapshot.entrantFingerprint)) {
    throw new ResearchError('DB_ERROR', 'Cohort history snapshot has invalid entrant fingerprint.');
  }
  if (snapshot.projectionVersion !== COHORT_HISTORY_PROJECTION_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Unsupported cohort history projection version ${snapshot.projectionVersion}; expected ${COHORT_HISTORY_PROJECTION_VERSION}.`,
    );
  }
  validatePolicy(snapshot.policy);
  if (snapshot.projections.length === 0) {
    throw new ResearchError('DB_ERROR', 'Cohort history snapshot requires at least one finalist projection.');
  }
  const clusterIds = new Set<string>();
  for (const projection of snapshot.projections) {
    if (clusterIds.has(projection.clusterId)) {
      throw new ResearchError('DB_ERROR', `Duplicate cohort history cluster ${projection.clusterId}.`);
    }
    clusterIds.add(projection.clusterId);
    if (projection.version !== snapshot.projectionVersion) {
      throw new ResearchError('DB_ERROR', `Cohort history ${projection.clusterId} version mismatch.`);
    }
    if (JSON.stringify(projection.policy) !== JSON.stringify(snapshot.policy)) {
      throw new ResearchError('DB_ERROR', `Cohort history ${projection.clusterId} policy mismatch.`);
    }
    validateProjectionArithmetic(projection);
  }
}

function validateProjectionArithmetic(projection: CohortHistoryProjection): void {
  const domainNames = new Set<string>();
  let checkedDomainCount = 0;
  let omittedDomainCount = 0;
  let unobservedDomainCount = 0;
  let registrationKnownDomainCount = 0;
  let youngDomainCount = 0;
  let firstSeenKnownDomainCount = 0;
  let recentWebPresenceCount = 0;
  let comparableHistoryDomainCount = 0;
  let possibleHistoryConflictCount = 0;
  const registrationStatusCounts: Record<string, number> = {};
  const firstSeenStatusCounts: Record<string, number> = {};

  for (const domain of projection.domains) {
    if (domainNames.has(domain.registrableDomain)) {
      throw new ResearchError(
        'DB_ERROR',
        `Cohort history ${projection.clusterId} contains duplicate domain ${domain.registrableDomain}.`,
      );
    }
    domainNames.add(domain.registrableDomain);
    registrationStatusCounts[domain.registration.status] =
      (registrationStatusCounts[domain.registration.status] ?? 0) + 1;
    firstSeenStatusCounts[domain.firstSeen.status] =
      (firstSeenStatusCounts[domain.firstSeen.status] ?? 0) + 1;

    if (domain.coverageStatus === 'checked') {
      checkedDomainCount += 1;
      if (domain.omitReason !== null) {
        throw new ResearchError('DB_ERROR', `Checked cohort history domain ${domain.registrableDomain} carries an omission reason.`);
      }
      if (domain.registration.status === 'unobserved' || domain.firstSeen.status === 'unobserved') {
        throw new ResearchError('DB_ERROR', `Checked cohort history domain ${domain.registrableDomain} carries an unobserved provider status.`);
      }
    } else if (domain.coverageStatus === 'omitted') {
      omittedDomainCount += 1;
      if (!domain.omitReason?.trim()) {
        throw new ResearchError('DB_ERROR', `Omitted cohort history domain ${domain.registrableDomain} has no omission reason.`);
      }
    } else {
      unobservedDomainCount += 1;
      if (
        domain.omitReason !== null
        || domain.registration.status !== 'unobserved'
        || domain.firstSeen.status !== 'unobserved'
      ) {
        throw new ResearchError('DB_ERROR', `Unobserved cohort history domain ${domain.registrableDomain} has contradictory evidence.`);
      }
    }

    const registrationKnown =
      domain.coverageStatus === 'checked'
      && domain.registration.status === 'ok'
      && domain.registration.ageDays !== null;
    if (registrationKnown) {
      registrationKnownDomainCount += 1;
      if (domain.registration.isYoung === null) {
        throw new ResearchError('DB_ERROR', `Known registration history for ${domain.registrableDomain} is missing young classification.`);
      }
    } else if (domain.registration.isYoung !== null) {
      throw new ResearchError('DB_ERROR', `Unknown registration history for ${domain.registrableDomain} carries young classification.`);
    }
    if (domain.registration.isYoung === true) youngDomainCount += 1;

    const firstSeenKnown =
      domain.coverageStatus === 'checked'
      && domain.firstSeen.status === 'ok'
      && domain.firstSeen.ageDays !== null;
    if (firstSeenKnown) {
      firstSeenKnownDomainCount += 1;
      if (domain.firstSeen.isRecent === null) {
        throw new ResearchError('DB_ERROR', `Known first-seen history for ${domain.registrableDomain} is missing recent classification.`);
      }
    } else if (domain.firstSeen.isRecent !== null) {
      throw new ResearchError('DB_ERROR', `Unknown first-seen history for ${domain.registrableDomain} carries recent classification.`);
    }
    if (domain.firstSeen.isRecent === true) recentWebPresenceCount += 1;

    const comparable =
      domain.coverageStatus === 'checked'
      && domain.registrationFirstSeenGapDays !== null;
    if (comparable) {
      comparableHistoryDomainCount += 1;
      if (domain.possibleHistoryConflict === null) {
        throw new ResearchError('DB_ERROR', `Comparable history for ${domain.registrableDomain} is missing conflict classification.`);
      }
    } else if (domain.possibleHistoryConflict !== null) {
      throw new ResearchError('DB_ERROR', `Non-comparable history for ${domain.registrableDomain} carries conflict classification.`);
    }
    if (domain.possibleHistoryConflict === true) {
      possibleHistoryConflictCount += 1;
      if (domain.historyConflictReason === null) {
        throw new ResearchError('DB_ERROR', `History conflict for ${domain.registrableDomain} has no reason.`);
      }
    } else if (domain.historyConflictReason !== null) {
      throw new ResearchError('DB_ERROR', `Non-conflicting history for ${domain.registrableDomain} carries a conflict reason.`);
    }
  }

  const summary = projection.summary;
  const expectedCounts = {
    cohortDomainCount: projection.domains.length,
    checkedDomainCount,
    omittedDomainCount,
    unobservedDomainCount,
    registrationKnownDomainCount,
    youngDomainCount,
    firstSeenKnownDomainCount,
    recentWebPresenceCount,
    comparableHistoryDomainCount,
    possibleHistoryConflictCount,
  };
  for (const [field, expected] of Object.entries(expectedCounts)) {
    const actual = summary[field as keyof typeof expectedCounts];
    if (actual !== expected) {
      throw new ResearchError(
        'DB_ERROR',
        `Cohort history ${projection.clusterId} ${field} is ${actual}; expected ${expected} from domain rows.`,
      );
    }
  }

  assertCoverage(
    projection.clusterId,
    'checkedCoverage',
    summary.checkedCoverage,
    checkedDomainCount,
    projection.domains.length,
  );
  assertCoverage(
    projection.clusterId,
    'youngDomainCoverage',
    summary.youngDomainCoverage,
    youngDomainCount,
    registrationKnownDomainCount,
  );
  assertCoverage(
    projection.clusterId,
    'recentWebPresenceCoverage',
    summary.recentWebPresenceCoverage,
    recentWebPresenceCount,
    firstSeenKnownDomainCount,
  );
  assertCoverage(
    projection.clusterId,
    'possibleHistoryConflictCoverage',
    summary.possibleHistoryConflictCoverage,
    possibleHistoryConflictCount,
    comparableHistoryDomainCount,
  );
  assertStatusCounts(projection.clusterId, 'registrationStatusCounts', summary.registrationStatusCounts, registrationStatusCounts);
  assertStatusCounts(projection.clusterId, 'firstSeenStatusCounts', summary.firstSeenStatusCounts, firstSeenStatusCounts);
}

function assertCoverage(
  clusterId: string,
  label: string,
  coverage: { numerator: number; denominator: number; ratio: number | null },
  numerator: number,
  denominator: number,
): void {
  const expectedRatio = denominator === 0 ? null : numerator / denominator;
  if (
    coverage.numerator !== numerator
    || coverage.denominator !== denominator
    || coverage.ratio !== expectedRatio
  ) {
    throw new ResearchError(
      'DB_ERROR',
      `Cohort history ${clusterId} ${label} does not match domain evidence (${numerator}/${denominator}).`,
    );
  }
}

function assertStatusCounts(
  clusterId: string,
  label: string,
  actual: Record<string, number>,
  expected: Record<string, number>,
): void {
  const actualEntries = Object.entries(actual).sort(([a], [b]) => a.localeCompare(b));
  const expectedEntries = Object.entries(expected).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new ResearchError('DB_ERROR', `Cohort history ${clusterId} ${label} does not match domain rows.`);
  }
}

function validatePolicy(policy: CohortHistoryPolicy): void {
  if (policy.version !== COHORT_HISTORY_PROJECTION_VERSION) {
    throw new ResearchError('DB_ERROR', `Unsupported cohort history policy version ${policy.version}.`);
  }
  for (const value of [
    policy.youngDomainMaxAgeDays,
    policy.recentWebPresenceMaxAgeDays,
    policy.repurposeGapMinDays,
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ResearchError('DB_ERROR', 'Cohort history policy thresholds must be non-negative integers.');
    }
  }
}

function normalizeSnapshot(snapshot: CohortHistorySnapshot): CohortHistorySnapshot {
  return {
    ...snapshot,
    policy: { ...snapshot.policy },
    projections: [...snapshot.projections]
      .sort((a, b) => compareClusterIds(a.clusterId, b.clusterId))
      .map((projection) => ({
        ...projection,
        policy: { ...projection.policy },
        domains: [...projection.domains].sort((a, b) => a.registrableDomain.localeCompare(b.registrableDomain)),
      })),
  };
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
