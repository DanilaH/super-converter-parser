import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStore, SCHEMA_VERSION } from './store.js';
import {
  loadRepresentativeQueryHistory,
  loadRepresentativeQuerySets,
  loadRepresentativeQueryState,
  saveRepresentativeQuerySnapshot,
} from './representativeSets.js';
import type { RepresentativeQuerySet } from '../enrichment/representativeQueries.js';
import type { RepresentativeQueryRunConfigSnapshot } from '../enrichment/types.js';

function config(...selectedClusterIds: string[]): RepresentativeQueryRunConfigSnapshot {
  return {
    targetCount: 5,
    overrides: [],
    setVersion: '1.0.0',
    selectedClusterIds,
  };
}

function set(clusterId: string, keywordIdx: number): RepresentativeQuerySet {
  return {
    clusterId,
    setVersion: '1.0.0',
    representativeKeywordIds: [keywordIdx],
    representatives: [{
      keywordIdx,
      keyword: `q${keywordIdx}`,
      normalizedKeyword: `q${keywordIdx}`,
      volume: null,
      selectionReason: 'medoid',
      coverageGain: 1,
    }],
    targetCount: 1,
    clusterUrlCount: 1,
    coveredUrlCount: 1,
    manualOverride: false,
    manualOverrideReason: null,
  };
}

test('representative extension is lazy and does not bump the core run-store schema', () => {
  const store = RunStore.openInMemory();
  try {
    assert.equal(store.version, SCHEMA_VERSION);
    assert.deepEqual(loadRepresentativeQuerySets(store, 'enr-1'), []);
    assert.equal(loadRepresentativeQueryState(store, 'enr-1'), null);
    assert.equal(store.version, SCHEMA_VERSION);

    saveRepresentativeQuerySnapshot(store, 'enr-1', config('cluster-1'), [set('cluster-1', 17)]);
    assert.equal(store.version, SCHEMA_VERSION);
  } finally {
    store.close();
  }
});

test('representative state round-trips every audit field', () => {
  const store = RunStore.openInMemory();
  try {
    const value: RepresentativeQuerySet = {
      ...set('cluster-1', 17),
      representativeKeywordIds: [17, 20],
      representatives: [
        {
          keywordIdx: 17,
          keyword: 'speaker test',
          normalizedKeyword: 'speaker test',
          volume: 1000,
          selectionReason: 'manual_override',
          coverageGain: 6,
        },
        {
          keywordIdx: 20,
          keyword: 'audio test',
          normalizedKeyword: 'audio test',
          volume: 900,
          selectionReason: 'manual_override',
          coverageGain: 2,
        },
      ],
      targetCount: 2,
      clusterUrlCount: 10,
      coveredUrlCount: 8,
      manualOverride: true,
      manualOverrideReason: 'reviewed intent coverage',
    };
    const snapshotConfig: RepresentativeQueryRunConfigSnapshot = {
      ...config('cluster-1'),
      overrides: [{
        clusterId: 'cluster-1',
        keywordIds: [17, 20],
        reason: 'reviewed intent coverage',
      }],
    };
    const saved = saveRepresentativeQuerySnapshot(store, 'enr-1', snapshotConfig, [value]);
    assert.deepEqual(saved, { revision: 1, changed: true });
    assert.deepEqual(loadRepresentativeQuerySets(store, 'enr-1'), [value]);
    const state = loadRepresentativeQueryState(store, 'enr-1');
    assert.equal(state?.revision, 1);
    assert.deepEqual(state?.config, snapshotConfig);
    assert.deepEqual(state?.sets, [value]);
    assert.equal(typeof state?.updatedAt, 'string');
  } finally {
    store.close();
  }
});

test('identical rerun preserves revision while a changed set or finalist scope appends durable history', () => {
  const store = RunStore.openInMemory();
  try {
    const firstConfig = config('cluster-1', 'cluster-2');
    const first = [set('cluster-1', 1), set('cluster-2', 2)];
    assert.deepEqual(
      saveRepresentativeQuerySnapshot(store, 'enr-1', firstConfig, first),
      { revision: 1, changed: true },
    );
    assert.deepEqual(
      saveRepresentativeQuerySnapshot(store, 'enr-1', firstConfig, first),
      { revision: 1, changed: false },
    );

    const secondConfig = config('cluster-1');
    const second = [set('cluster-1', 3)];
    assert.deepEqual(
      saveRepresentativeQuerySnapshot(store, 'enr-1', secondConfig, second),
      { revision: 2, changed: true },
    );

    const current = loadRepresentativeQueryState(store, 'enr-1');
    assert.equal(current?.revision, 2);
    assert.deepEqual(current?.config.selectedClusterIds, ['cluster-1']);
    assert.deepEqual(current?.sets.map((row) => row.representativeKeywordIds), [[3]]);

    const history = loadRepresentativeQueryHistory(store, 'enr-1');
    assert.equal(history.length, 2);
    assert.equal(history[0]?.revision, 1);
    assert.deepEqual(history[0]?.config.selectedClusterIds, ['cluster-1', 'cluster-2']);
    assert.deepEqual(history[0]?.sets.map((row) => row.representativeKeywordIds), [[1], [2]]);
    assert.equal(history[1]?.revision, 2);
    assert.deepEqual(history[1]?.sets.map((row) => row.representativeKeywordIds), [[3]]);
  } finally {
    store.close();
  }
});

test('config-only change is revisioned because selection semantics changed', () => {
  const store = RunStore.openInMemory();
  try {
    const sets = [set('cluster-1', 1)];
    const baseConfig = config('cluster-1');
    saveRepresentativeQuerySnapshot(store, 'enr-1', baseConfig, sets);
    const changedConfig = { ...baseConfig, targetCount: 4 };
    assert.deepEqual(
      saveRepresentativeQuerySnapshot(store, 'enr-1', changedConfig, sets),
      { revision: 2, changed: true },
    );
    assert.equal(loadRepresentativeQueryHistory(store, 'enr-1').length, 2);
  } finally {
    store.close();
  }
});

test('persistence rejects a set outside finalist scope before mutating SQLite', () => {
  const store = RunStore.openInMemory();
  try {
    assert.throws(
      () => saveRepresentativeQuerySnapshot(store, 'enr-1', config('cluster-1'), [
        set('cluster-2', 2),
      ]),
      /outside the selected finalist scope/,
    );
    assert.deepEqual(loadRepresentativeQuerySets(store, 'enr-1'), []);
  } finally {
    store.close();
  }
});

test('persistence rejects mismatched representative ids and rows', () => {
  const store = RunStore.openInMemory();
  try {
    const invalid = set('cluster-1', 1);
    invalid.representativeKeywordIds = [2];
    assert.throws(
      () => saveRepresentativeQuerySnapshot(store, 'enr-1', config('cluster-1'), [invalid]),
      /keyword ids do not match representative rows/,
    );
  } finally {
    store.close();
  }
});

test('persistence rejects coverage accounting that exceeds the cluster denominator', () => {
  const store = RunStore.openInMemory();
  try {
    const invalid = set('cluster-1', 1);
    invalid.coveredUrlCount = 2;
    assert.throws(
      () => saveRepresentativeQuerySnapshot(store, 'enr-1', config('cluster-1'), [invalid]),
      /invalid URL coverage counts/,
    );
  } finally {
    store.close();
  }
});
