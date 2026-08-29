import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FIXTURE_ROOT = new URL('./fixtures/hardware-audio-v1/', import.meta.url);

type ManifestRun = {
  label: string;
  file: string;
  sourceRunId: string;
  archiveName: string;
  archiveSha256: string;
  observationCount: number;
  derivedPairCount: number;
  derivedV1Edges: Array<[number, number]>;
  v1ClusterCount: number;
  selectedDomainHistoryCount: number;
};

type CorpusManifest = {
  fixtureVersion: string;
  summary: {
    runCount: number;
    observationCount: number;
    derivedPairCount: number;
    derivedV1EdgeCount: number;
    v1ClusterCount: number;
    selectedDomainHistoryCount: number;
  };
  runs: ManifestRun[];
};

type Observation = {
  keywordIdx: number;
  keyword: string;
  normalizedKeyword: string;
  market: string | null;
  volume: number | null;
  cpc: number | null;
  organicTop10: Array<{
    position: number;
    url: string;
    domain: string;
    dr: number | null;
  }>;
};

type RunFixture = {
  label: string;
  provenance: {
    archiveName: string;
    archiveSha256: string;
    sourceRunId: string;
    sourceInput: string;
    sourceState: string;
    parserVersions: { surfer: string; google: string };
    ahrefsState: string | null;
    enrichmentId: string;
    enrichmentState: string;
  };
  v1Clustering: {
    algorithmVersion: string;
    config: {
      topN: number;
      edgeRule: { minSharedDomains: number; minJaccard: number };
      algorithmVersion: string;
    };
    observations: Observation[];
    expectedClusters: Array<{
      canonicalKeywordIdx: number;
      memberKeywordIdxs: number[];
    }>;
    selectedDomainHistory: Array<{
      domain: string;
      registrationDate: string | null;
      registrationStatus: string;
      firstSeenDate: string | null;
      firstSeenStatus: string;
      domainAgeDays: number | null;
      omitted: boolean;
      omitReason: string | null;
    }>;
  };
};

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, 'utf8')) as T;
}

function recomputePair(a: Observation, b: Observation) {
  const domainsA = new Set(a.organicTop10.map((row) => row.domain));
  const domainsB = new Set(b.organicTop10.map((row) => row.domain));
  const intersectionCount = [...domainsA].filter((domain) => domainsB.has(domain)).length;
  const unionCount = new Set([...domainsA, ...domainsB]).size;
  return {
    intersectionCount,
    unionCount,
    jaccard: unionCount === 0 ? 0 : intersectionCount / unionCount,
  };
}

function components(keywordIdxs: number[], edges: Array<[number, number]>): number[][] {
  const adjacency = new Map(keywordIdxs.map((idx) => [idx, new Set<number>()]));
  for (const [a, b] of edges) {
    adjacency.get(a)?.add(b);
    adjacency.get(b)?.add(a);
  }
  const visited = new Set<number>();
  const out: number[][] = [];
  for (const start of [...keywordIdxs].sort((a, b) => a - b)) {
    if (visited.has(start)) continue;
    const queue = [start];
    const memberIdxs: number[] = [];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      memberIdxs.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    out.push(memberIdxs.sort((a, b) => a - b));
  }
  return out.sort((a, b) => a[0]! - b[0]!);
}

test('Hardware/Audio corpus manifest freezes three real V1 research runs', async () => {
  const manifest = await readJson<CorpusManifest>(new URL('manifest.json', FIXTURE_ROOT));

  assert.equal(manifest.fixtureVersion, '1.0.0');
  assert.deepEqual(manifest.summary, {
    runCount: 3,
    observationCount: 24,
    derivedPairCount: 97,
    derivedV1EdgeCount: 2,
    v1ClusterCount: 22,
    selectedDomainHistoryCount: 13,
  });
  assert.deepEqual(manifest.runs.map((run) => run.label), [
    'initial',
    'residual_round_3',
    'targeted_round_2',
  ]);
  assert.equal(new Set(manifest.runs.map((run) => run.sourceRunId)).size, 3);
  assert.equal(new Set(manifest.runs.map((run) => run.archiveSha256)).size, 3);
  assert.ok(manifest.runs.every((run) => /^[a-f0-9]{64}$/.test(run.archiveSha256)));
});

test('V1 domain-overlap graph and final components reproduce from frozen raw SERP evidence', async () => {
  const manifest = await readJson<CorpusManifest>(new URL('manifest.json', FIXTURE_ROOT));

  for (const entry of manifest.runs) {
    const fixture = await readJson<RunFixture>(new URL(entry.file, FIXTURE_ROOT));
    const v1 = fixture.v1Clustering;
    const observations = [...v1.observations].sort((a, b) => a.keywordIdx - b.keywordIdx);
    const byIdx = new Map(observations.map((observation) => [observation.keywordIdx, observation]));

    assert.equal(fixture.label, entry.label);
    assert.equal(fixture.provenance.sourceRunId, entry.sourceRunId);
    assert.equal(fixture.provenance.archiveName, entry.archiveName);
    assert.equal(fixture.provenance.archiveSha256, entry.archiveSha256);
    assert.equal(fixture.provenance.sourceState, 'completed');
    assert.equal(fixture.provenance.enrichmentState, 'completed');
    assert.equal(fixture.provenance.ahrefsState, 'complete');
    assert.equal(v1.algorithmVersion, '1.0.0');
    assert.equal(v1.config.algorithmVersion, '1.0.0');
    assert.equal(observations.length, entry.observationCount);
    assert.equal(byIdx.size, observations.length);
    assert.equal(v1.selectedDomainHistory.length, entry.selectedDomainHistoryCount);

    for (const observation of observations) {
      assert.ok(observation.organicTop10.length > 0 && observation.organicTop10.length <= v1.config.topN);
      assert.deepEqual(
        observation.organicTop10.map((row) => row.position),
        Array.from({ length: observation.organicTop10.length }, (_, index) => index + 1),
      );
      assert.ok(observation.organicTop10.every((row) => row.url.startsWith('http')));
      assert.ok(observation.organicTop10.every((row) => row.domain.length > 0));
    }

    const derivedEdges: Array<[number, number]> = [];
    let pairCount = 0;
    for (let aIndex = 0; aIndex < observations.length; aIndex += 1) {
      for (let bIndex = aIndex + 1; bIndex < observations.length; bIndex += 1) {
        pairCount += 1;
        const a = observations[aIndex]!;
        const b = observations[bIndex]!;
        const pair = recomputePair(a, b);
        if (
          pair.intersectionCount >= v1.config.edgeRule.minSharedDomains
          && pair.jaccard >= v1.config.edgeRule.minJaccard
        ) {
          derivedEdges.push([a.keywordIdx, b.keywordIdx]);
        }
      }
    }
    assert.equal(pairCount, entry.derivedPairCount);
    assert.deepEqual(derivedEdges, entry.derivedV1Edges);

    const derivedComponents = components(observations.map((observation) => observation.keywordIdx), derivedEdges);
    const expectedComponents = v1.expectedClusters
      .map((cluster) => [...cluster.memberKeywordIdxs].sort((a, b) => a - b))
      .sort((a, b) => a[0]! - b[0]!);
    assert.deepEqual(derivedComponents, expectedComponents);
    assert.equal(expectedComponents.length, entry.v1ClusterCount);
    assert.ok(v1.expectedClusters.every((cluster) => cluster.memberKeywordIdxs.includes(cluster.canonicalKeywordIdx)));

    const selectedDomains = new Set(
      observations.flatMap((observation) => observation.organicTop10.map((row) => row.domain)),
    );
    assert.ok(v1.selectedDomainHistory.every((record) => selectedDomains.has(record.domain)));
  }
});

test('corpus preserves the two V1 merges that clustering v2 must review explicitly', async () => {
  const manifest = await readJson<CorpusManifest>(new URL('manifest.json', FIXTURE_ROOT));
  const namedEdges: Array<{ run: string; keywords: string[]; sharedDomains: number; jaccard: number }> = [];

  for (const entry of manifest.runs) {
    const fixture = await readJson<RunFixture>(new URL(entry.file, FIXTURE_ROOT));
    const byIdx = new Map(fixture.v1Clustering.observations.map((observation) => [observation.keywordIdx, observation]));
    for (const [aIdx, bIdx] of entry.derivedV1Edges) {
      const a = byIdx.get(aIdx)!;
      const b = byIdx.get(bIdx)!;
      const pair = recomputePair(a, b);
      namedEdges.push({
        run: entry.label,
        keywords: [a.normalizedKeyword, b.normalizedKeyword].sort(),
        sharedDomains: pair.intersectionCount,
        jaccard: pair.jaccard,
      });
    }
  }

  assert.deepEqual(namedEdges, [
    {
      run: 'initial',
      keywords: ['double click test', 'mouse scroll test'],
      sharedDomains: 5,
      jaccard: 5 / 14,
    },
    {
      run: 'targeted_round_2',
      keywords: ['audio test', 'speaker test'],
      sharedDomains: 4,
      jaccard: 4 / 12,
    },
  ]);
});
