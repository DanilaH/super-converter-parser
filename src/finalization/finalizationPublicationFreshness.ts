import { createHash } from 'node:crypto';
import { ResearchError } from '../shared/errors.js';

const REQUIRED_FINALIZATION_ARTIFACTS = [
  'representative-queries.json',
  'entrant-cohort.json',
  'finalist-evidence-matrix.json',
] as const;

export type FinalizationPublicationLineage = {
  representativeRevision: number | null;
  entrantRepresentativeRevision: number | null;
  entrantFingerprint: string | null;
  cohortHistoryFingerprint: string | null;
  historicalPresenceFingerprint: string | null;
};

export function finalizationParentFingerprint<T extends { updatedAt: string }>(state: T): string {
  const { updatedAt: _updatedAt, ...snapshot } = state;
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function isCurrentFinalizationPublication(input: {
  manifest: Record<string, unknown>;
  lineage: FinalizationPublicationLineage;
}): boolean {
  const {
    representativeRevision,
    entrantRepresentativeRevision,
    entrantFingerprint,
    cohortHistoryFingerprint,
    historicalPresenceFingerprint,
  } = input.lineage;
  if (
    representativeRevision === null
    || entrantRepresentativeRevision === null
    || entrantFingerprint === null
    || entrantRepresentativeRevision !== representativeRevision
  ) {
    return false;
  }

  const artifacts = readStringArray(input.manifest.artifacts);
  if (artifacts === null || REQUIRED_FINALIZATION_ARTIFACTS.some((name) => !artifacts.includes(name))) {
    return false;
  }
  if (cohortHistoryFingerprint !== null && !artifacts.includes('cohort-history.json')) return false;
  if (historicalPresenceFingerprint !== null && !artifacts.includes('cohort-historical-presence.json')) return false;

  const representatives = readRecord(input.manifest.representativeQueries);
  const entrant = readRecord(input.manifest.entrantCohort);
  const finalist = readRecord(input.manifest.finalistEvidence);
  if (representatives === null || entrant === null || finalist === null) return false;

  return representatives.revision === representativeRevision
    && entrant.representativeRevision === representativeRevision
    && finalist.representativeRevision === representativeRevision
    && finalist.entrantFingerprint === entrantFingerprint
    && finalist.cohortHistoryFingerprint === cohortHistoryFingerprint
    && finalist.historicalPresenceFingerprint === historicalPresenceFingerprint;
}

export function assertCurrentFinalizationPublication(input: {
  manifest: Record<string, unknown>;
  lineage: FinalizationPublicationLineage;
  enrichmentId: string;
}): void {
  if (isCurrentFinalizationPublication(input)) return;
  throw new ResearchError(
    'INPUT_SCHEMA_ERROR',
    `Enrichment ${input.enrichmentId} does not have finalist publication artifacts pinned to the current representative/entrant/deep-evidence lineage. Resume finalization before publishing to the library.`,
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[]
    : null;
}
