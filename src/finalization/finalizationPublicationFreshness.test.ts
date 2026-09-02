import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import {
  assertCurrentFinalizationPublication,
  isCurrentFinalizationPublication,
  type FinalizationPublicationLineage,
} from './finalizationPublicationFreshness.js';

function manifest(revision = 2, entrantFingerprint = 'entrant-current'): Record<string, unknown> {
  return {
    artifacts: [
      'representative-queries.json',
      'entrant-cohort.json',
      'finalist-evidence-matrix.json',
    ],
    representativeQueries: { revision },
    entrantCohort: { representativeRevision: revision },
    finalistEvidence: {
      representativeRevision: revision,
      entrantFingerprint,
    },
  };
}

const currentLineage: FinalizationPublicationLineage = {
  representativeRevision: 2,
  entrantRepresentativeRevision: 2,
  entrantFingerprint: 'entrant-current',
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

test('matrix must still be manifest-published', () => {
  const staleManifest = manifest();
  staleManifest.artifacts = ['representative-queries.json', 'entrant-cohort.json'];
  assert.equal(isCurrentFinalizationPublication({ manifest: staleManifest, lineage: currentLineage }), false);
});
