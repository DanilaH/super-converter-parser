import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRepresentativeSourceFreshness } from './representativeSourceFreshness.js';

test('source completed before clustering snapshot is accepted', () => {
  assert.doesNotThrow(() => assertRepresentativeSourceFreshness({
    sourceRunId: 'source-1',
    sourceUpdatedAt: '2026-08-29T10:00:00.000Z',
    clusteringUpdatedAt: '2026-08-29T10:05:00.000Z',
  }));
});

test('equal timestamps are accepted conservatively', () => {
  assert.doesNotThrow(() => assertRepresentativeSourceFreshness({
    sourceRunId: 'source-1',
    sourceUpdatedAt: '2026-08-29T10:00:00.000Z',
    clusteringUpdatedAt: '2026-08-29T10:00:00.000Z',
  }));
});

test('source mutation after clustering is rejected before representative evidence is rebuilt', () => {
  assert.throws(
    () => assertRepresentativeSourceFreshness({
      sourceRunId: 'source-1',
      sourceUpdatedAt: '2026-08-29T10:06:00.000Z',
      clusteringUpdatedAt: '2026-08-29T10:05:00.000Z',
    }),
    /modified after the persisted clustering snapshot/,
  );
});

test('malformed timestamps fail loudly instead of weakening the guard', () => {
  assert.throws(
    () => assertRepresentativeSourceFreshness({
      sourceRunId: 'source-1',
      sourceUpdatedAt: 'not-a-date',
      clusteringUpdatedAt: '2026-08-29T10:05:00.000Z',
    }),
    /Invalid source run source-1 updatedAt/,
  );
});
