import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CLUSTERING_ALGORITHM_VERSION,
  clusterKeywords,
  type ClusteringConfig,
  type ClusteringInput,
} from './clustering.js';

const FIXTURE_ROOT = new URL('./fixtures/hardware-audio-v1/', import.meta.url);

const CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: {
    minSharedDomains: 3,
    minJaccard: 0.3,
    minSharedUrls: 2,
    minUrlJaccard: 0.1,
  },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
};

type Observation = {
  keywordIdx: number;
  keyword: string;
  normalizedKeyword: string;
  volume: number | null;
  organicTop10: Array<{ position: number; url: string; domain: string }>;
};

type RunFixture = {
  label: string;
  v1Clustering: {
    observations: Observation[];
  };
};

async function readFixture(file: string): Promise<RunFixture> {
  return JSON.parse(await readFile(new URL(file, FIXTURE_ROOT), 'utf8')) as RunFixture;
}

function toInputs(observations: Observation[]): ClusteringInput[] {
  return observations.map((observation) => {
    const rows = [...observation.organicTop10].sort((a, b) => a.position - b.position);
    return {
      keywordIdx: observation.keywordIdx,
      keyword: observation.keyword,
      normalizedKeyword: observation.normalizedKeyword,
      volume: observation.volume,
      domains: rows.map((row) => row.domain),
      urls: rows.map((row) => row.url),
    };
  });
}

function pair(
  result: ReturnType<typeof clusterKeywords>,
  a: number,
  b: number,
) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return result.pairs.find((row) => row.keywordAIdx === low && row.keywordBIdx === high);
}

test('clustering v2 changes only the evidence-supported Hardware/Audio merge decisions', async () => {
  const initial = clusterKeywords(
    toInputs((await readFixture('initial.json')).v1Clustering.observations),
    CONFIG,
  );
  const residual = clusterKeywords(
    toInputs((await readFixture('residual-round-3.json')).v1Clustering.observations),
    CONFIG,
  );
  const targeted = clusterKeywords(
    toInputs((await readFixture('targeted-round-2.json')).v1Clustering.observations),
    CONFIG,
  );

  assert.equal(initial.algorithmVersion, '2.0.0');
  assert.equal(initial.config.groupingRule, 'complete_link');
  assert.equal(initial.config.urlIdentityVersion, '1.0.0');

  assert.equal(initial.clusters.length, 12);
  assert.equal(initial.edgeCount, 0);
  assert.equal(pair(initial, 29, 39)?.classification, 'domain_only');
  assert.equal(pair(initial, 29, 39)?.domainIntersectionCount, 5);
  assert.equal(pair(initial, 29, 39)?.urlIntersectionCount, 1);
  assert.equal(pair(initial, 20, 39)?.classification, 'url_only');
  assert.equal(pair(initial, 20, 39)?.urlIntersectionCount, 2);

  assert.equal(residual.clusters.length, 7);
  assert.equal(residual.edgeCount, 0);

  assert.equal(targeted.clusters.length, 4);
  assert.equal(targeted.edgeCount, 1);
  assert.equal(pair(targeted, 17, 20)?.classification, 'strong');
  assert.equal(pair(targeted, 17, 20)?.domainIntersectionCount, 4);
  assert.equal(pair(targeted, 17, 20)?.urlIntersectionCount, 3);
  assert.equal(
    targeted.clusters.some((cluster) => {
      const ids = cluster.members.map((member) => member.keywordIdx).sort((a, b) => (a ?? 0) - (b ?? 0));
      return ids.length === 2 && ids[0] === 17 && ids[1] === 20;
    }),
    true,
  );

  assert.equal(initial.clusters.length + residual.clusters.length + targeted.clusters.length, 23);
  assert.equal(initial.edgeCount + residual.edgeCount + targeted.edgeCount, 1);
});
