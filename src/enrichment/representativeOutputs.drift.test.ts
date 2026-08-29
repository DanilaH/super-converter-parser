import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRepresentativeQueriesJson } from './representativeOutputs.js';
import type { RepresentativeQuerySet } from './representativeQueries.js';

function set(reason: 'medoid' | 'manual_override', manual: boolean): RepresentativeQuerySet {
  return {
    clusterId: 'cluster-1',
    setVersion: '1.0.0',
    representativeKeywordIds: [17],
    representatives: [{
      keywordIdx: 17,
      keyword: 'speaker test',
      normalizedKeyword: 'speaker test',
      volume: 9900,
      selectionReason: reason,
      coverageGain: 8,
    }],
    targetCount: 1,
    clusterUrlCount: 8,
    coveredUrlCount: 8,
    manualOverride: manual,
    manualOverrideReason: manual ? 'human-reviewed canonical intent' : null,
  };
}

test('same representative ids still report drift when selection semantics change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'representative-drift-'));
  try {
    const path = join(directory, 'representative-queries.json');
    await writeRepresentativeQueriesJson(path, {
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      config: {
        targetCount: 5,
        overrides: [{
          clusterId: 'cluster-1',
          keywordIds: [17],
          reason: 'human-reviewed canonical intent',
        }],
        setVersion: '1.0.0',
        selectedClusterIds: ['cluster-1'],
      },
      sets: [set('manual_override', true)],
      revision: 2,
      changed: true,
      previousSets: [set('medoid', false)],
    });

    const json = JSON.parse(await readFile(path, 'utf8')) as {
      sets: Array<{
        representativeKeywordIds: number[];
        previousRepresentativeKeywordIds: number[] | null;
        changedFromPrevious: boolean | null;
      }>;
    };
    assert.deepEqual(json.sets[0]?.representativeKeywordIds, [17]);
    assert.deepEqual(json.sets[0]?.previousRepresentativeKeywordIds, [17]);
    assert.equal(json.sets[0]?.changedFromPrevious, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
