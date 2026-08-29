import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRepresentativeOverridesJson,
  resolveRepresentativeQueriesConfig,
} from './representativeConfig.js';

test('override JSON is strict and preserves explicit manual order', () => {
  const overrides = parseRepresentativeOverridesJson(JSON.stringify([
    {
      clusterId: 'cluster-2',
      keywordIds: [20, 17],
      reason: 'manual intent review',
    },
  ]));
  assert.deepEqual(overrides, [{
    clusterId: 'cluster-2',
    keywordIds: [20, 17],
    reason: 'manual intent review',
  }]);
});

test('override JSON rejects typo fields instead of silently ignoring them', () => {
  assert.throws(
    () => parseRepresentativeOverridesJson(JSON.stringify([
      {
        clusterId: 'cluster-1',
        keywordIds: [1],
        reason: 'reviewed',
        keywordId: 2,
      },
    ])),
    /unknown field\(s\): keywordId/,
  );
});

test('config rerun inherits persisted values and finalist scope unless explicitly changed', () => {
  const existing = {
    targetCount: 4,
    overrides: [{ clusterId: 'cluster-1', keywordIds: [1, 2], reason: 'reviewed' }],
    setVersion: '0.9.0',
    selectedClusterIds: ['cluster-10', 'cluster-2'],
  };
  assert.deepEqual(resolveRepresentativeQueriesConfig({ existing }), {
    targetCount: 4,
    overrides: existing.overrides,
    setVersion: '1.0.0',
    selectedClusterIds: ['cluster-2', 'cluster-10'],
  });
  assert.deepEqual(resolveRepresentativeQueriesConfig({ existing, targetCount: 6 }), {
    targetCount: 6,
    overrides: existing.overrides,
    setVersion: '1.0.0',
    selectedClusterIds: ['cluster-2', 'cluster-10'],
  });
});

test('explicit empty override file clears persisted manual overrides', () => {
  const existing = {
    targetCount: 5,
    overrides: [{ clusterId: 'cluster-1', keywordIds: [1], reason: 'reviewed' }],
    setVersion: '1.0.0',
    selectedClusterIds: ['cluster-1'],
  };
  assert.deepEqual(resolveRepresentativeQueriesConfig({ existing, overrides: [] }).overrides, []);
});

test('first run requires explicit finalist cluster scope', () => {
  assert.throws(
    () => resolveRepresentativeQueriesConfig({}),
    /at least one explicitly selected finalist cluster/,
  );
});

test('scope changes are normalized to stable numeric cluster order', () => {
  const resolved = resolveRepresentativeQueriesConfig({
    selectedClusterIds: ['cluster-10', 'cluster-1', 'cluster-2'],
  });
  assert.deepEqual(resolved.selectedClusterIds, ['cluster-1', 'cluster-2', 'cluster-10']);
});

test('duplicate finalist cluster ids are rejected rather than silently deduped', () => {
  assert.throws(
    () => resolveRepresentativeQueriesConfig({
      selectedClusterIds: ['cluster-1', 'cluster-1'],
    }),
    /Duplicate representative finalist cluster id/,
  );
});
