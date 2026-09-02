import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceSnapshotFingerprint } from './evidenceSnapshotFingerprint.js';

test('snapshot fingerprint ignores storage-only updatedAt', () => {
  const first = evidenceSnapshotFingerprint({
    enrichmentId: 'enrich-1',
    updatedAt: '2026-09-02T10:00:00.000Z',
    payload: { count: 2 },
  });
  const second = evidenceSnapshotFingerprint({
    enrichmentId: 'enrich-1',
    updatedAt: '2026-09-02T11:00:00.000Z',
    payload: { count: 2 },
  });
  assert.equal(first, second);
});

test('snapshot fingerprint changes when durable evidence changes', () => {
  const first = evidenceSnapshotFingerprint({
    enrichmentId: 'enrich-1',
    updatedAt: '2026-09-02T10:00:00.000Z',
    payload: { count: 2 },
  });
  const second = evidenceSnapshotFingerprint({
    enrichmentId: 'enrich-1',
    updatedAt: '2026-09-02T10:00:00.000Z',
    payload: { count: 3 },
  });
  assert.notEqual(first, second);
});
