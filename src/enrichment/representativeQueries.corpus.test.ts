import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CLUSTERING_ALGORITHM_VERSION,
  clusterKeywords,
  type ClusteringConfig,
  type ClusteringInput,
} from './clustering.js';
import { selectRepresentativeQueries } from './representativeQueries.js';

const FIXTURE = new URL('./fixtures/hardware-audio-v1/targeted-round-2.json', import.meta.url);

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

type Fixture = {
  v1Clustering: {
    observations: Observation[];
  };
};

function toInput(observation: Observation): ClusteringInput {
  const rows = [...observation.organicTop10].sort((a, b) => a.position - b.position);
  return {
    keywordIdx: observation.keywordIdx,
    keyword: observation.keyword,
    normalizedKeyword: observation.normalizedKeyword,
    volume: observation.volume,
    domains: rows.map((row) => row.domain),
    urls: rows.map((row) => row.url),
  };
}

test('frozen Hardware/Audio strong cluster selects speaker medoid plus higher-demand audio query', async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8')) as Fixture;
  const observations = fixture.v1Clustering.observations;
  const clustering = clusterKeywords(observations.map(toInput), CONFIG);
  const cluster = clustering.clusters.find((row) => {
    const ids = row.members.map((member) => member.keywordIdx).sort((a, b) => (a ?? 0) - (b ?? 0));
    return ids.length === 2 && ids[0] === 17 && ids[1] === 20;
  });
  assert.ok(cluster);

  const memberUrls = new Map<number, string[]>();
  for (const observation of observations) {
    memberUrls.set(
      observation.keywordIdx,
      [...observation.organicTop10]
        .sort((a, b) => a.position - b.position)
        .slice(0, CONFIG.topN)
        .map((row) => row.url),
    );
  }

  const selected = selectRepresentativeQueries({
    cluster,
    pairs: clustering.pairs,
    memberUrls,
  });

  assert.deepEqual(selected.representativeKeywordIds, [17, 20]);
  assert.equal(selected.representatives[0]?.keyword, 'speaker test');
  assert.equal(selected.representatives[0]?.selectionReason, 'medoid');
  assert.equal(selected.representatives[1]?.keyword, 'audio test');
  assert.equal(selected.representatives[1]?.volume, 14800);
  assert.equal(selected.representatives[1]?.selectionReason, 'high_demand');
  assert.equal(selected.clusterUrlCount, 15);
  assert.equal(selected.coveredUrlCount, 15);
});
