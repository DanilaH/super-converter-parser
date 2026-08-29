import Database from 'better-sqlite3';
import type {
  FinalistBuildDecision,
  FinalistSeoProductRole,
} from '../enrichment/finalistEvidence.js';
import { ResearchError } from '../shared/errors.js';
import { entrantCohortFingerprint } from './cohortHistory.js';
import { loadEntrantCohortState } from './entrantCohorts.js';
import { loadRepresentativeQueryState } from './representativeSets.js';
import type { RunStore } from './store.js';

export const FINALIST_DECISION_SCHEMA_VERSION = 1;

export type FinalistDecisionInput = {
  clusterId: string;
  buildDecision: FinalistBuildDecision | null;
  seoProductRole: FinalistSeoProductRole | null;
};

export type FinalistDecisionRecord = FinalistDecisionInput & {
  representativeRevision: number;
  entrantFingerprint: string;
  updatedAt: string;
};

type StoreWithDb = { db: Database.Database };

type DecisionRow = {
  enrichment_id: string;
  cluster_id: string;
  build_decision: string | null;
  seo_product_role: string | null;
  representative_revision: number;
  entrant_fingerprint: string;
  updated_at: string;
};

function dbOf(store: RunStore): Database.Database {
  return (store as unknown as StoreWithDb).db;
}

function schemaExists(store: RunStore): boolean {
  return Boolean(dbOf(store)
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'finalist_decision_schema'")
    .get());
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finalist_decision_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL
    );
  `);
  const version = db
    .prepare('SELECT version FROM finalist_decision_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (version && version.version !== FINALIST_DECISION_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Finalist decision schema version ${version.version} is unsupported by this build (${FINALIST_DECISION_SCHEMA_VERSION}).`,
    );
  }
  if (!version) {
    db.prepare('INSERT INTO finalist_decision_schema (singleton, version) VALUES (1, ?)')
      .run(FINALIST_DECISION_SCHEMA_VERSION);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_finalist_decisions (
      enrichment_id TEXT NOT NULL,
      cluster_id TEXT NOT NULL,
      build_decision TEXT,
      seo_product_role TEXT,
      representative_revision INTEGER NOT NULL,
      entrant_fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (enrichment_id, cluster_id)
    );
  `);
}

function assertSchemaReadable(store: RunStore): boolean {
  if (!schemaExists(store)) return false;
  const version = dbOf(store)
    .prepare('SELECT version FROM finalist_decision_schema WHERE singleton = 1')
    .get() as { version: number } | undefined;
  if (!version || version.version !== FINALIST_DECISION_SCHEMA_VERSION) {
    throw new ResearchError(
      'DB_ERROR',
      `Unsupported finalist decision schema version ${version?.version ?? 'missing'}; expected ${FINALIST_DECISION_SCHEMA_VERSION}.`,
    );
  }
  return true;
}

export function replaceFinalistDecisions(
  store: RunStore,
  enrichmentId: string,
  decisions: FinalistDecisionInput[],
): FinalistDecisionRecord[] {
  const enrichment = store.loadEnrichmentRun(enrichmentId);
  if (!enrichment) {
    throw new ResearchError('DB_ERROR', `Finalist decision enrichment ${enrichmentId} does not exist.`);
  }
  if (enrichment.state !== 'completed') {
    throw new ResearchError(
      'DB_ERROR',
      `Finalist decisions require completed enrichment ${enrichmentId}; current state is ${enrichment.state}.`,
    );
  }

  const representatives = loadRepresentativeQueryState(store, enrichmentId);
  if (!representatives) {
    throw new ResearchError('DB_ERROR', `Finalist decisions require persisted representative-query state for ${enrichmentId}.`);
  }
  const entrant = loadEntrantCohortState(store, enrichmentId);
  if (!entrant) {
    throw new ResearchError('DB_ERROR', `Finalist decisions require persisted entrant-cohort state for ${enrichmentId}.`);
  }
  if (entrant.representativeRevision !== representatives.revision) {
    throw new ResearchError(
      'DB_ERROR',
      `Finalist decision parent mismatch: representative revision ${representatives.revision} != entrant revision ${entrant.representativeRevision}.`,
    );
  }

  const currentClusters = new Set(representatives.sets.map((set) => set.clusterId));
  const normalized = normalizeDecisionInputs(decisions, currentClusters);
  const entrantFingerprint = entrantCohortFingerprint(entrant);
  const updatedAt = new Date().toISOString();
  const db = dbOf(store);

  const tx = db.transaction(() => {
    applySchema(db);
    db.prepare('DELETE FROM enrichment_finalist_decisions WHERE enrichment_id = ?').run(enrichmentId);
    const insert = db.prepare(`
      INSERT INTO enrichment_finalist_decisions (
        enrichment_id, cluster_id, build_decision, seo_product_role,
        representative_revision, entrant_fingerprint, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const decision of normalized) {
      insert.run(
        enrichmentId,
        decision.clusterId,
        decision.buildDecision,
        decision.seoProductRole,
        representatives.revision,
        entrantFingerprint,
        updatedAt,
      );
    }
  });
  tx();

  return normalized.map((decision) => ({
    ...decision,
    representativeRevision: representatives.revision,
    entrantFingerprint,
    updatedAt,
  }));
}

export function loadFinalistDecisions(
  store: RunStore,
  enrichmentId: string,
): FinalistDecisionRecord[] {
  if (!assertSchemaReadable(store)) return [];
  const rows = dbOf(store)
    .prepare(`
      SELECT *
      FROM enrichment_finalist_decisions
      WHERE enrichment_id = ?
    `)
    .all(enrichmentId) as DecisionRow[];

  try {
    return rows
      .map((row) => {
        if (row.enrichment_id !== enrichmentId) throw new Error('enrichment id mismatch');
        const decision = normalizeDecisionInput({
          clusterId: row.cluster_id,
          buildDecision: row.build_decision as FinalistBuildDecision | null,
          seoProductRole: row.seo_product_role as FinalistSeoProductRole | null,
        });
        if (!Number.isInteger(row.representative_revision) || row.representative_revision < 1) {
          throw new Error(`invalid representative revision for ${row.cluster_id}`);
        }
        if (!/^[a-f0-9]{64}$/.test(row.entrant_fingerprint)) {
          throw new Error(`invalid entrant fingerprint for ${row.cluster_id}`);
        }
        if (!Number.isFinite(Date.parse(row.updated_at))) {
          throw new Error(`invalid updated timestamp for ${row.cluster_id}`);
        }
        return {
          ...decision,
          representativeRevision: row.representative_revision,
          entrantFingerprint: row.entrant_fingerprint,
          updatedAt: row.updated_at,
        };
      })
      .sort((a, b) => compareClusterIds(a.clusterId, b.clusterId));
  } catch (error) {
    throw new ResearchError(
      'DB_ERROR',
      `Corrupt finalist decision state for enrichment ${enrichmentId}.`,
      { cause: error },
    );
  }
}

function normalizeDecisionInputs(
  decisions: FinalistDecisionInput[],
  currentClusters: ReadonlySet<string>,
): FinalistDecisionInput[] {
  const seen = new Set<string>();
  return decisions
    .map((decision) => normalizeDecisionInput(decision))
    .map((decision) => {
      if (!currentClusters.has(decision.clusterId)) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `Finalist decision references unknown current finalist ${decision.clusterId}.`,
        );
      }
      if (seen.has(decision.clusterId)) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `Duplicate finalist decision for ${decision.clusterId}.`);
      }
      seen.add(decision.clusterId);
      return decision;
    })
    .filter((decision) => decision.buildDecision !== null || decision.seoProductRole !== null)
    .sort((a, b) => compareClusterIds(a.clusterId, b.clusterId));
}

function normalizeDecisionInput(decision: FinalistDecisionInput): FinalistDecisionInput {
  const clusterId = decision.clusterId.trim();
  if (clusterId === '') throw new Error('Finalist decision requires a cluster id');
  validateBuildDecision(decision.buildDecision);
  validateSeoProductRole(decision.seoProductRole);
  return {
    clusterId,
    buildDecision: decision.buildDecision,
    seoProductRole: decision.seoProductRole,
  };
}

function validateBuildDecision(value: FinalistBuildDecision | null): void {
  if (value === null) return;
  if (value !== 'build' && value !== 'watch' && value !== 'reject' && value !== 'unknown') {
    throw new Error(`Invalid finalist build decision ${String(value)}`);
  }
}

function validateSeoProductRole(value: FinalistSeoProductRole | null): void {
  if (value === null) return;
  if (
    value !== 'acquisition_anchor'
    && value !== 'strong_supporting_tool'
    && value !== 'completeness_tool'
    && value !== 'experimental'
    && value !== 'not_applicable'
  ) {
    throw new Error(`Invalid finalist SEO/product role ${String(value)}`);
  }
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
