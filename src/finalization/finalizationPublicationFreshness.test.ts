import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import {
  assertCurrentFinalizationPublication,
  isCurrentFinalizationPublication,
  type FinalizationPublicationLineage,
} from './finalizationPublicationFreshness.js';

function manifest(
  revision = 2,
  entrantFingerprint = 'entrant-current',
  cohortHistoryFingerprint: string | null = 'cohort-current',
  historicalPresenceFingerprint: string | null = 'history-current',
): Record<string, unknown> {
  return {
    artifacts: [
      'representative-queries.json',
      'entrant-cohort.json',
      'cohort-history.json',
      'cohort-historical-presence.json',
      'finalist-evidence-matrix.json',
    ],
    representativeQueries: { revision },
    entrantCohort: { representativeRevision: revision },
    finalistEvidence: {
      representativeRevision: revision,
      entrantFingerprint,
      cohortHistoryFingerprint,
      historicalPresenceFingerprint,
    },
  };
}

const currentLineage: FinalizationPublicationLineage = {
  representativeRevision: 2,
  entrantRepresentativeRevision: 2,
  entrantFingerprint: 'entrant-current',
  cohortHistoryFingerprint: 'cohort-current',
  historicalPresenceFingerprint: 'history-current',
};

test('current finalist publication lineage is accepted', () => {
  assert.equal(isCurrentFinalizationPublication({ manifest: manifest(), lineage: currentLineage }), true);
  assert.doesNotThrow(() => assertCurrentFinalizationPublication({
    manifest: manifest(),
    lineage: currentLineage,
    enrichmentId: 'enrich-1',
  }));
});

test('stale manifest from the previous representative revision is rejected', () => {
  assert.equal(isCurrentFinalizationPublication({
    manifest: manifest(1, 'entrant-old'),
    lineage: currentLineage,
  }), false);
});

test('missing current entrant parent is rejected even when old matrix artifacts remain in the manifest', () => {
  const lineage: FinalizationPublicationLineage = {
    representativeRevision: 2,
    entrantRepresentativeRevision: null,
    entrantFingerprint: null,
    cohortHistoryFingerprint: null,
    historicalPresenceFingerprint: null,
  };
  assert.throws(
    () => assertCurrentFinalizationPublication({ manifest: manifest(1, 'entrant-old'), lineage, enrichmentId: 'enrich-1' }),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /resume finalization/i.test(error.message),
  );
});

test('stale entrant fingerprint is rejected', () => {
  assert.equal(isCurrentFinalizationPublication({
    manifest: manifest(2, 'entrant-old'),
    lineage: currentLineage,
  }), false);
});

test('stale cohort-history fingerprint is rejected after a crash before metadata invalidation', () => {
  assert.equal(isCurrentFinalizationPublication({
    manifest: manifest(2, 'entrant-current', 'cohort-old', 'history-current'),
    lineage: currentLineage,
  }), false);
});

test('stale sampled historical-presence fingerprint is rejected after a crash before metadata invalidation', () => {
  assert.equal(isCurrentFinalizationPublication({
    manifest: manifest(2, 'entrant-current', 'cohort-current', 'history-old'),
    lineage: currentLineage,
  }), false);
});

test('optional deep-evidence parents are pinned explicitly as null', () => {
  const lineage: FinalizationPublicationLineage = {
    ...currentLineage,
    cohortHistoryFingerprint: null,
    historicalPresenceFingerprint: null,
  };
  const withoutOptionalParents = manifest(2, 'entrant-current', null, null);
  withoutOptionalParents.artifacts = [
    'representative-queries.json',
    'entrant-cohort.json',
    'finalist-evidence-matrix.json',
  ];
  assert.equal(isCurrentFinalizationPublication({ manifest: withoutOptionalParents, lineage }), true);
});

test('current deep-evidence parents must still be manifest-published', () => {
  const staleManifest = manifest();
  staleManifest.artifacts = [
    'representative-queries.json',
    'entrant-cohort.json',
    'finalist-evidence-matrix.json',
  ];
  assert.equal(isCurrentFinalizationPublication({ manifest: staleManifest, lineage: currentLineage }), false);
});

test('matrix must still be manifest-published', () => {
  const staleManifest = manifest();
  staleManifest.artifacts = [
    'representative-queries.json',
    'entrant-cohort.json',
    'cohort-history.json',
    'cohort-historical-presence.json',
  ];
  assert.equal(isCurrentFinalizationPublication({ manifest: staleManifest, lineage: currentLineage }), false);
});
