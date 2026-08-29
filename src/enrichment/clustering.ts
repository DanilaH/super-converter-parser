import type {
  ClusterEdgeRule,
  ClusterEvidence,
  ClusterMember,
  KeywordCluster,
  ClusteringConfig,
  PairwiseComparison,
  ClusteredKeywordExclusion,
} from './types.js';

export type { ClusteringConfig } from './types.js';

export const CLUSTERING_ALGORITHM_VERSION = '1.0.0';

export type ClusteringInput = {
  keywordIdx: number;
  keyword: string;
  normalizedKeyword: string;
  volume: number | null;
  domains: string[];
};

type PairEvidence = {
  a: number;
  b: number;
  evidence: ClusterEvidence;
};

export type ClusteringResult = {
  clusters: KeywordCluster[];
  pairs: PairwiseComparison[];
  exclusions: ClusteredKeywordExclusion[];
  config: ClusteringConfig;
  algorithmVersion: string;
  inputCount: number;
  excludedCount: number;
  edgeCount: number;
};

export function clusterKeywords(
  inputs: ClusteringInput[],
  config: ClusteringConfig,
): ClusteringResult {
  const topN = config.topN;
  const { minSharedDomains, minJaccard } = config.edgeRule;

  const keywordInputMap = new Map<number, ClusteringInput>();
  for (const input of inputs) {
    if (keywordInputMap.has(input.keywordIdx)) {
      throw new Error(`Duplicate source keyword index in clustering input: ${input.keywordIdx}`);
    }
    keywordInputMap.set(input.keywordIdx, input);
  }

  const valid: ClusteringInput[] = [];
  const exclusions: ClusteredKeywordExclusion[] = [];

  for (const input of inputs) {
    if (input.domains.length === 0) {
      exclusions.push({
        keywordIdx: input.keywordIdx,
        keyword: input.keyword,
        normalizedKeyword: input.normalizedKeyword,
        reason: 'no_domains',
        serpSize: 0,
      });
      continue;
    }
    valid.push(input);
  }

  const compareInputs = (a: ClusteringInput, b: ClusteringInput): number =>
    a.normalizedKeyword.localeCompare(b.normalizedKeyword)
    || a.keyword.localeCompare(b.keyword)
    || a.keywordIdx - b.keywordIdx;
  valid.sort(compareInputs);
  exclusions.sort((a, b) =>
    (a.keywordIdx ?? Number.MAX_SAFE_INTEGER) - (b.keywordIdx ?? Number.MAX_SAFE_INTEGER)
    || a.normalizedKeyword.localeCompare(b.normalizedKeyword)
    || a.keyword.localeCompare(b.keyword),
  );

  const excludedCount = inputs.length - valid.length;

  // Source keyword idx is the graph identity. Text is retained only as
  // user-facing/semantic metadata and never owns an edge/member relation.
  const domainSets = new Map<number, Set<string>>();
  for (const input of valid) {
    const set = new Set<string>();
    for (let i = 0; i < Math.min(input.domains.length, topN); i += 1) {
      set.add(input.domains[i]!);
    }
    domainSets.set(input.keywordIdx, set);
  }

  const keywordIds = valid.map((input) => input.keywordIdx);
  const edges: PairEvidence[] = [];
  const adjacency = new Map<number, Set<number>>();
  const allPairs: PairwiseComparison[] = [];

  for (let i = 0; i < keywordIds.length; i += 1) {
    const a = keywordIds[i]!;
    const setA = domainSets.get(a)!;
    const inputA = keywordInputMap.get(a)!;
    for (let j = i + 1; j < keywordIds.length; j += 1) {
      const b = keywordIds[j]!;
      const setB = domainSets.get(b)!;
      const inputB = keywordInputMap.get(b)!;

      let intersectionSize = 0;
      const shared: string[] = [];
      for (const domain of setA) {
        if (setB.has(domain)) {
          intersectionSize += 1;
          shared.push(domain);
        }
      }

      const unionSize = setA.size + setB.size - intersectionSize;
      const jaccard = unionSize === 0 ? 0 : intersectionSize / unionSize;
      const isEdge = intersectionSize >= minSharedDomains && jaccard >= minJaccard;

      shared.sort();
      const pairAIdx = Math.min(a, b);
      const pairBIdx = Math.max(a, b);
      const pairAInput = pairAIdx === a ? inputA : inputB;
      const pairBInput = pairBIdx === b ? inputB : inputA;
      allPairs.push({
        keywordAIdx: pairAIdx,
        keywordBIdx: pairBIdx,
        keywordA: pairAInput.normalizedKeyword,
        keywordB: pairBInput.normalizedKeyword,
        intersectionCount: intersectionSize,
        unionCount: unionSize,
        jaccard,
        sharedDomains: shared,
        isEdge,
      });

      if (!isEdge) continue;

      const evidence: ClusterEvidence = {
        sharedDomains: shared,
        intersectionCount: intersectionSize,
        unionCount: unionSize,
        jaccard,
      };
      edges.push({ a, b, evidence });

      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a)!.add(b);
      adjacency.get(b)!.add(a);
    }
  }

  allPairs.sort((a, b) =>
    (a.keywordAIdx ?? Number.MAX_SAFE_INTEGER) - (b.keywordAIdx ?? Number.MAX_SAFE_INTEGER)
    || (a.keywordBIdx ?? Number.MAX_SAFE_INTEGER) - (b.keywordBIdx ?? Number.MAX_SAFE_INTEGER),
  );

  const compareKeywordIds = (a: number, b: number): number =>
    compareInputs(keywordInputMap.get(a)!, keywordInputMap.get(b)!);

  const visited = new Set<number>();
  const components: number[][] = [];

  for (const keywordIdx of keywordIds) {
    if (visited.has(keywordIdx)) continue;
    if (!adjacency.has(keywordIdx)) {
      components.push([keywordIdx]);
      visited.add(keywordIdx);
      continue;
    }
    const component: number[] = [];
    const queue: number[] = [keywordIdx];
    visited.add(keywordIdx);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }
    component.sort(compareKeywordIds);
    components.push(component);
  }

  const pairJaccardMap = new Map<string, number>();
  for (const pair of allPairs) {
    if (pair.keywordAIdx === null || pair.keywordBIdx === null) continue;
    pairJaccardMap.set(pairKey(pair.keywordAIdx, pair.keywordBIdx), pair.jaccard);
  }

  const rawClusters: Array<{
    members: number[];
    canonicalKeywordIdx: number;
    representativeDomains: string[];
    medianVolume: number | null;
    averageVolume: number | null;
  }> = [];

  for (const memberIds of components) {
    const memberInputs = memberIds
      .map((id) => keywordInputMap.get(id)!)
      .filter(Boolean);

    const memberVolumes = memberInputs
      .map((member) => member.volume)
      .filter((volume): volume is number => volume !== null && volume !== undefined);

    const medianVolume =
      memberVolumes.length > 0 ? median(memberVolumes) : null;
    const averageVolume =
      memberVolumes.length > 0
        ? memberVolumes.reduce((sum, volume) => sum + volume, 0) / memberVolumes.length
        : null;

    const domainFrequency = new Map<string, { count: number; rankSum: number }>();
    for (const member of memberInputs) {
      const set = domainSets.get(member.keywordIdx);
      if (!set) continue;
      let rank = 0;
      for (const domain of member.domains.slice(0, topN)) {
        rank += 1;
        if (!set.has(domain)) continue;
        const existing = domainFrequency.get(domain);
        if (existing) {
          existing.count += 1;
          existing.rankSum += rank;
        } else {
          domainFrequency.set(domain, { count: 1, rankSum: rank });
        }
      }
    }

    const representativeDomains = [...domainFrequency.entries()]
      .sort((a, b) => {
        if (b[1].count !== a[1].count) return b[1].count - a[1].count;
        const avgRankA = a[1].rankSum / a[1].count;
        const avgRankB = b[1].rankSum / b[1].count;
        if (avgRankA !== avgRankB) return avgRankA - avgRankB;
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      })
      .map(([domain]) => domain);

    let canonicalKeywordIdx = memberIds[0] ?? -1;
    if (memberIds.length > 1) {
      let bestScore = -1;
      let bestVolume = -1;
      for (const memberIdx of memberIds) {
        let jaccardSum = 0;
        for (const otherIdx of memberIds) {
          if (memberIdx === otherIdx) continue;
          jaccardSum += pairJaccardMap.get(pairKey(memberIdx, otherIdx)) ?? 0;
        }
        const member = keywordInputMap.get(memberIdx)!;
        const volume = member.volume ?? null;
        const currentCanonical = keywordInputMap.get(canonicalKeywordIdx)!;
        const lexicalOrder = compareInputs(member, currentCanonical);
        if (
          jaccardSum > bestScore ||
          (jaccardSum === bestScore && (volume ?? -1) > bestVolume) ||
          (jaccardSum === bestScore && (volume ?? -1) === bestVolume && lexicalOrder < 0)
        ) {
          bestScore = jaccardSum;
          bestVolume = volume ?? -1;
          canonicalKeywordIdx = memberIdx;
        }
      }
    }

    rawClusters.push({
      members: memberIds,
      canonicalKeywordIdx,
      representativeDomains,
      medianVolume,
      averageVolume,
    });
  }

  rawClusters.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return compareKeywordIds(a.canonicalKeywordIdx, b.canonicalKeywordIdx);
  });

  const clusters: KeywordCluster[] = rawClusters.map((rawCluster, idx) => {
    const memberInputs = rawCluster.members
      .map((memberIdx) => keywordInputMap.get(memberIdx)!)
      .filter(Boolean);

    const clusterMembers: ClusterMember[] = memberInputs.map((member) => ({
      keywordIdx: member.keywordIdx,
      keyword: member.keyword,
      normalizedKeyword: member.normalizedKeyword,
      volume: member.volume,
      serpSize: domainSets.get(member.keywordIdx)?.size ?? 0,
    }));
    const canonical = keywordInputMap.get(rawCluster.canonicalKeywordIdx)!;

    return {
      clusterId: `cluster-${idx + 1}`,
      canonicalKeywordIdx: rawCluster.canonicalKeywordIdx,
      canonicalKeyword: canonical.keyword,
      members: clusterMembers,
      representativeDomains: rawCluster.representativeDomains,
      medianVolume: rawCluster.medianVolume,
      averageVolume: rawCluster.averageVolume,
      memberCount: rawCluster.members.length,
    };
  });

  return {
    clusters,
    pairs: allPairs,
    exclusions,
    config,
    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
    inputCount: inputs.length,
    excludedCount,
    edgeCount: edges.length,
  };
}

function pairKey(a: number, b: number): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}