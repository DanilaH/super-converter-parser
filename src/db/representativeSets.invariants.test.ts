import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from './store.js';
import { saveRepresentativeQuerySnapshot } from './representativeSets.js';
import type { RepresentativeQuerySet } from '../enrichment/representativeQueries.js';
import type { RepresentativeQueryRunConfigSnapshot } from '../enrichment/types.js';

const CONFIG: RepresentativeQueryRunConfigSnapshot = {
  targetCount: 5,
  overrides: [{
    clusterId: 'cluster-1',
    keywordIds: [2, 1],
    reason: 'human-reviewed intent coverage',
  }],
  setVersion: '1.0.0',
  selectedClusterIds: ['cluster-1'],
};

function manualSet(): RepresentativeQuerySet {
  return {
    clusterId: 'cluster-1',
    setVersion: '1.0.0',
    representativeKeywordIds: [2, 1],
    representatives: [
      {
        keywordIdx: 2,
        keyword: 'q2',
        normalizedKeyword: 'q2',
        volume: 200,
        selectionReason: 'manual_override',
        coverageGain: 2,
      },
      {
        keywordIdx: 1,
        keyword: 'q1',
        normalizedKeyword: 'q1',
        volume: 100,
        selectionReason: 'manual_override',
        coverageGain: 1,
      },
    ],
    targetCount: 2,
    clusterUrlCount: 3,
    coveredUrlCount: 3,
    manualOverride: true,
    manualOverrideReason: 'human-reviewed intent coverage',
  };
}

test('persistence rejects manual ids that differ from the versioned override config', () => {
  const store = RunStore.openInMemory();
  try {
    const invalid = manualSet();
    invalid.representativeKeywordIds = [1, 2];
    invalid.representatives = [invalid.representatives[1]!, invalid.representatives[0]!];
    assert.throws(
      () => saveRepresentativeQuerySnapshot(store, 'enr-1', CONFIG, [invalid]),
      /override keyword ids mismatch/,
    );
  } finally {
    store.close();
  }
});

test('persistence rejects manual reason drift from the versioned override config', () => {
  const store = RunStore.openInMemory();
  try {
    const invalid = manualSet();
    invalid.manualOverrideReason = 'different later explanation';
    assert.throws(
      () => saveRepresentativeQuerySnapshot(store, 'enr-1', CONFIG, [invalid]),
      /override reason mismatch/,
    );
  } finally {
    store.close();
  }
});

test('persistence rejects automatic state when an override exists for the finalist cluster', () => {
  const store = RunStore.openInMemory();
  try {
    const invalid = manualSet();
    invalid.manualOverride = false;
    invalid.manualOverrideReason = null;
    invalid.representatives = invalid.representatives.map((row, index) => ({
      ...row,
      selectionReason: index === 0 ? 'medoid' : 'high_demand',
    }));
    assert.throws(
      () => saveRepresentativeQuerySnapshot(store, 'enr-1', CONFIG, [invalid]),
      /not reflected in its persisted set/,
    );
  } finally {
    store.close();
  }
});
