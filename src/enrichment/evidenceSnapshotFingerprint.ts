import { createHash } from 'node:crypto';

export function evidenceSnapshotFingerprint<T extends { updatedAt?: string }>(state: T): string {
  const { updatedAt: _updatedAt, ...snapshot } = state;
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
