import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunningSnapshotCadence } from './snapshotCadence.js';

test('publishes first running snapshot then throttles until keyword interval', () => {
  const cadence = new RunningSnapshotCadence(3, 60_000);

  assert.deepEqual(cadence.decide('running', 1_000), { publish: true, reason: 'first' });
  cadence.markPublished(1_000);

  assert.deepEqual(cadence.decide('running', 1_100), { publish: false, reason: 'skip' });
  assert.deepEqual(cadence.decide('running', 1_200), { publish: false, reason: 'skip' });
  assert.deepEqual(cadence.decide('running', 1_300), { publish: true, reason: 'keyword_interval' });
});

test('time interval forces a running snapshot even before keyword interval', () => {
  const cadence = new RunningSnapshotCadence(50, 1_000);

  assert.deepEqual(cadence.decide('running', 1_000), { publish: true, reason: 'first' });
  cadence.markPublished(1_000);

  assert.deepEqual(cadence.decide('running', 1_500), { publish: false, reason: 'skip' });
  assert.deepEqual(cadence.decide('running', 2_000), { publish: true, reason: 'time_interval' });
});

test('paused and terminal states are never throttled', () => {
  const cadence = new RunningSnapshotCadence(50, 60_000);

  assert.deepEqual(cadence.decide('paused', 1_000), { publish: true, reason: 'terminal' });
  assert.deepEqual(cadence.decide('completed', 1_100), { publish: true, reason: 'terminal' });
  assert.deepEqual(cadence.decide('completed_with_errors', 1_200), { publish: true, reason: 'terminal' });
});

test('failed publish is not marked and next running callback is still eligible', () => {
  const cadence = new RunningSnapshotCadence(50, 60_000);

  assert.deepEqual(cadence.decide('running', 1_000), { publish: true, reason: 'first' });
  // No markPublished: publication failed.
  assert.deepEqual(cadence.decide('running', 1_100), { publish: true, reason: 'first' });
});
