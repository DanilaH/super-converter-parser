import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeRepresentativeQueriesCsv,
  writeRepresentativeQueriesJson,
} from './representativeOutputs.js';
import type { RepresentativeQuerySet } from './representativeQueries.js';

const CONFIG = {
  targetCount: 5,
  overrides: [],
  setVersion: '1.0.0',
  selectedClusterIds: ['cluster-1'],
};

const SET: RepresentativeQuerySet = {
  clusterId: 'cluster-1',
  setVersion: '1.0.0',
  representativeKeywordIds: [17, 20],
  representatives: [
    {
      keywordIdx: 17,
      keyword: 'speaker test',
      normalizedKeyword: 'speaker test',
      volume: 1000,
      selectionReason: 'medoid',
      coverageGain: 6,
    },
    {
      keywordIdx: 20,
      keyword: 'audio test',
      normalizedKeyword: 'audio test',
      volume: 900,
      selectionReason: 'high_demand',
      coverageGain: 2,
    },
  ],
  targetCount: 2,
  clusterUrlCount: 10,
  coveredUrlCount: 8,
  manualOverride: false,
  manualOverrideReason: null,
};

test('representative artifacts expose selected ids, reasons, revision, finalist scope and URL coverage denominator', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'representative-output-'));
  try {
    const csvPath = join(directory, 'representative-queries.csv');
    const jsonPath = join(directory, 'representative-queries.json');
    await writeRepresentativeQueriesCsv(csvPath, { sets: [SET], revision: 1 });
    await writeRepresentativeQueriesJson(jsonPath, {
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      config: CONFIG,
      sets: [SET],
      revision: 1,
      changed: true,
    });

    const csv = await readFile(csvPath, 'utf8');
    assert.match(csv, /representative_keyword_ids/);
    assert.match(csv, /revision/);
    assert.match(csv, /17;20/);
    assert.match(csv, /medoid;high_demand/);
    assert.match(csv, /8,10,80\.00/);

    const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
      revision: number;
      changed: boolean;
      config: { selectedClusterIds: string[] };
      sets: Array<{
        representativeKeywordIds: number[];
        coveragePercent: number | null;
        changedFromPrevious: boolean | null;
        previousRepresentativeKeywordIds: number[] | null;
      }>;
    };
    assert.equal(json.revision, 1);
    assert.equal(json.changed, true);
    assert.deepEqual(json.config.selectedClusterIds, ['cluster-1']);
    assert.deepEqual(json.sets[0]?.representativeKeywordIds, [17, 20]);
    assert.equal(json.sets[0]?.coveragePercent, 80);
    assert.equal(json.sets[0]?.changedFromPrevious, null);
    assert.equal(json.sets[0]?.previousRepresentativeKeywordIds, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('changed representative ids expose the previous selection in both artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'representative-output-change-'));
  try {
    const previous: RepresentativeQuerySet = {
      ...SET,
      representativeKeywordIds: [17],
      representatives: [SET.representatives[0]!],
    };
    const csvPath = join(directory, 'representative-queries.csv');
    const jsonPath = join(directory, 'representative-queries.json');
    await writeRepresentativeQueriesCsv(csvPath, {
      sets: [SET],
      revision: 2,
      previousSets: [previous],
    });
    await writeRepresentativeQueriesJson(jsonPath, {
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      config: CONFIG,
      sets: [SET],
      revision: 2,
      changed: true,
      previousSets: [previous],
    });

    const csv = await readFile(csvPath, 'utf8');
    assert.match(csv, /cluster-1,2,true,17,/);
    const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
      sets: Array<{
        changedFromPrevious: boolean | null;
        previousRepresentativeKeywordIds: number[] | null;
      }>;
    };
    assert.equal(json.sets[0]?.changedFromPrevious, true);
    assert.deepEqual(json.sets[0]?.previousRepresentativeKeywordIds, [17]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('zero-URL cluster reports missing coverage percent instead of a fake zero percent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'representative-output-zero-'));
  try {
    const jsonPath = join(directory, 'representative-queries.json');
    const zeroSet: RepresentativeQuerySet = {
      ...SET,
      clusterUrlCount: 0,
      coveredUrlCount: 0,
    };
    await writeRepresentativeQueriesJson(jsonPath, {
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      config: CONFIG,
      sets: [zeroSet],
      revision: 1,
      changed: true,
    });
    const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
      sets: Array<{ coveragePercent: number | null }>;
    };
    assert.equal(json.sets[0]?.coveragePercent, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
