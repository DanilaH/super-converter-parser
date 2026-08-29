import type {
  ClusterCohesion,
  ClusterCohesionSummary,
  ClusterEdgeRule,
  ClusterMember,
  ClusterPairClassification,
  KeywordCluster,
  ClusteringConfig,
  PairwiseComparison,
  ClusteredKeywordExclusion,
} from './types.js';
import { CLUSTER_URL_IDENTITY_VERSION, clusteringUrlIdentity } from './urlIdentity.js';

export type { ClusteringConfig } from './types.js';

export const CLUSTERING_ALGORITHM_VERSION = '2.0.0';
export const DEFAULT_CLUSTER_MIN_SHARED_URLS = 2;
export const DEFAULT_CLUSTER_MIN_URL_JACCARD = 0.1;

export type ClusteringInput = {
  keywordIdx: number;
  keyword: string;
  normalizedKeyword: string;
  volume: number | null;
  // Ranked organic evidence. `domains` and `urls` are parallel arrays from the
  // same SERP rows; topN is applied before set deduplication.
  domains: string[];
  urls: string[];
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
  const edgeRule = effectiveEdgeRule(config.edgeRule);
  const effectiveConfig: ClusteringConfig = {
    ...config,
    edgeRule,
    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
    urlIdentityVersion: CLUSTER_URL_IDENTITY_VERSION,
    groupingRule: 'complete_link',
  };

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
    const topDomains = input.domains.slice(0, topN).filter((domain) => domain !== '');
    if (topDomains.length === 0) {
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

  const domainSets = new Map<number, Set<string>>();
  const urlSets = new Map<number, Set<string>>();
  for (const input of valid) {
    domainSets.set(
      input.keywordIdx,
      new Set(input.domains.slice(0, topN).filter((domain) => domain !== '')),
    );

    const urls = new Set<string>();
    for (const rawUrl of input.urls.slice(0, topN)) {
      const identity = clusteringUrlIdentity(rawUrl);
      if (identity !== null) urls.add(identity);
    }
    urlSets.set(input.keywordIdx, urls);
  }

  const keywordIds = valid.map((input) => input.keywordIdx);
  const allPairs: PairwiseComparison[] = [];
  const pairMap = new Map<string, PairwiseComparison>();

  for (let i = 0; i < keywordIds.length; i += 1) {
    const a = keywordIds[i]!;
    const domainsA = domainSets.get(a)!;
    const urlsA = urlSets.get(a)!;
    const inputA = keywordInputMap.get(a)!;

    for (let j = i + 1; j < keywordIds.length; j += 1) {
      const b = keywordIds[j]!;
      const domainsB = domainSets.get(b)!;
      const urlsB = urlSets.get(b)!;
      const inputB = keywordInputMap.get(b)!;

      const domainEvidence = overlap(domainsA, domainsB);
      const urlEvidence = overlap(urlsA, urlsB);
      const domainStrong =
        domainEvidence.intersectionCount >= edgeRule.minSharedDomains
        && domainEvidence.jaccard >= edgeRule.minJaccard;
      const urlStrong =
        urlEvidence.intersectionCount >= edgeRule.minSharedUrls
        && urlEvidence.jaccard >= edgeRule.minUrlJaccard;
      const classification = classifyPair(
        domainStrong,
        urlStrong,
        domainEvidence.intersectionCount,
        urlEvidence.intersectionCount,
      );
      const isEdge = classification === 'strong';

      const pairAIdx = Math.min(a, b);
      const pairBIdx = Math.max(a, b);
      const pairAInput = pairAIdx === a ? inputA : inputB;
      const pairBInput = pairBIdx === b ? inputB : inputA;
      const pair: PairwiseComparison = {
        keywordAIdx: pairAIdx,
        keywordBIdx: pairBIdx,
        keywordA: pairAInput.normalizedKeyword,
        keywordB: pairBInput.normalizedKeyword,
        // V1 compatibility aliases remain the domain metrics.
        intersectionCount: domainEvidence.intersectionCount,
        unionCount: domainEvidence.unionCount,
        jaccard: domainEvidence.jaccard,
        sharedDomains: domainEvidence.shared,
        sharedUrls: urlEvidence.shared,
        urlIntersectionCount: urlEvidence.intersectionCount,
        urlUnionCount: urlEvidence.unionCount,
        urlJaccard: urlEvidence.jaccard,
        domainIntersectionCount: domainEvidence.intersectionCount,
        domainUnionCount: domainEvidence.unionCount,
        domainJaccard: domainEvidence.jaccard,
        classification,
        isEdge,
      };
      allPairs.push(pair);
      pairMap.set(pairKey(pairAIdx, pairBIdx), pair);
    }
  }

  allPairs.sort((a, b) =>
    (a.keywordAIdx ?? Number.MAX_SAFE_INTEGER) - (b.keywordAIdx ?? Number.MAX_SAFE_INTEGER)
    || (a.keywordBIdx ?? Number.MAX_SAFE_INTEGER) - (b.keywordBIdx ?? Number.MAX_SAFE_INTEGER),
  );

  const compareKeywordIds = (a: number, b: number): number =>
    compareInputs(keywordInputMap.get(a)!, keywordInputMap.get(b)!);

  const groups = buildCompleteLinkGroups(keywordIds, pairMap, compareKeywordIds);

  const rawClusters: Array<{
    members: number[];
    canonicalKeywordIdx: number;
    representativeDomains: string[];
    medianVolume: number | null;
    averageVolume: number | null;
    cohesion: ClusterCohesion;
  }> = [];

  for (const memberIds of groups) {
    const memberInputs = memberIds.map((id) => keywordInputMap.get(id)!).filter(Boolean);
    const memberVolumes = memberInputs
      .map((member) => member.volume)
      .filter((volume): volume is number => volume !== null && volume !== undefined);

    const medianVolume = memberVolumes.length > 0 ? median(memberVolumes) : null;
    const averageVolume = memberVolumes.length > 0
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
        return a[0].localeCompare(b[0]);
      })
      .map(([domain]) => domain);

    let canonicalKeywordIdx = memberIds[0] ?? -1;
    if (memberIds.length > 1) {
      let bestScore = -1;
      let bestVolume = -1;
      for (const memberIdx of memberIds) {
        let domainJaccardSum = 0;
        for (const otherIdx of memberIds) {
          if (memberIdx === otherIdx) continue;
          domainJaccardSum += pairDomainJaccard(pairMap.get(pairKey(memberIdx, otherIdx)));
        }
        const member = keywordInputMap.get(memberIdx)!;
        const volume = member.volume ?? -1;
        const currentCanonical = keywordInputMap.get(canonicalKeywordIdx)!;
        const lexicalOrder = compareInputs(member, currentCanonical);
        if (
          domainJaccardSum > bestScore
          || (domainJaccardSum === bestScore && volume > bestVolume)
          || (domainJaccardSum === bestScore && volume === bestVolume && lexicalOrder < 0)
        ) {
          bestScore = domainJaccardSum;
          bestVolume = volume;
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
      cohesion: clusterCohesion(memberIds, pairMap),
    });
  }

  rawClusters.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return compareKeywordIds(a.canonicalKeywordIdx, b.canonicalKeywordIdx);
  });

  const clusters: KeywordCluster[] = rawClusters.map((rawCluster, idx) => {
    const memberInputs = rawCluster.members.map((memberIdx) => keywordInputMap.get(memberIdx)!).filter(Boolean);
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
      cohesion: rawCluster.cohesion,
    };
  });

  return {
    clusters,
    pairs: allPairs,
    exclusions,
    config: effectiveConfig,
    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
    inputCount: inputs.length,
    excludedCount,
    edgeCount: allPairs.filter((pair) => pair.isEdge).length,
  };
}

function effectiveEdgeRule(rule: ClusterEdgeRule): ClusterEdgeRule & {
  minSharedUrls: number;
  minUrlJaccard: number;
} {
  return {
    ...rule,
    minSharedUrls: rule.minSharedUrls ?? DEFAULT_CLUSTER_MIN_SHARED_URLS,
    minUrlJaccard: rule.minUrlJaccard ?? DEFAULT_CLUSTER_MIN_URL_JACCARD,
  };
}

function overlap(a: Set<string>, b: Set<string>): {
  shared: string[];
  intersectionCount: number;
  unionCount: number;
  jaccard: number;
} {
  const shared = [...a].filter((value) => b.has(value)).sort();
  const unionCount = a.size + b.size - shared.length;
  return {
    shared,
    intersectionCount: shared.length,
    unionCount,
    jaccard: unionCount === 0 ? 0 : shared.length / unionCount,
  };
}

function classifyPair(
  domainStrong: boolean,
  urlStrong: boolean,
  sharedDomains: number,
  sharedUrls: number,
): ClusterPairClassification {
  if (domainStrong && urlStrong) return 'strong';
  if (domainStrong) return 'domain_only';
  if (urlStrong) return 'url_only';
  if (sharedDomains > 0 || sharedUrls > 0) return 'weak';
  return 'none';
}

function buildCompleteLinkGroups(
  keywordIds: number[],
  pairs: Map<string, PairwiseComparison>,
  compareKeywordIds: (a: number, b: number) => number,
): number[][] {
  let groups = keywordIds.map((keywordIdx) => [keywordIdx]);

  while (true) {
    const candidates: Array<{
      aIndex: number;
      bIndex: number;
      merged: number[];
      minUrlJaccard: number;
      minDomainJaccard: number;
      meanUrlJaccard: number;
      meanDomainJaccard: number;
    }> = [];

    for (let aIndex = 0; aIndex < groups.length; aIndex += 1) {
      for (let bIndex = aIndex + 1; bIndex < groups.length; bIndex += 1) {
        const a = groups[aIndex]!;
        const b = groups[bIndex]!;
        const crossPairs = a.flatMap((aIdx) => b.map((bIdx) => pairs.get(pairKey(aIdx, bIdx))));
        if (crossPairs.some((pair) => pair?.isEdge !== true)) continue;

        const urlValues = crossPairs.map(pairUrlJaccard);
        const domainValues = crossPairs.map(pairDomainJaccard);
        candidates.push({
          aIndex,
          bIndex,
          merged: [...a, ...b].sort(compareKeywordIds),
          minUrlJaccard: Math.min(...urlValues),
          minDomainJaccard: Math.min(...domainValues),
          meanUrlJaccard: mean(urlValues),
          meanDomainJaccard: mean(domainValues),
        });
      }
    }

    if (candidates.length === 0) break;
    candidates.sort((a, b) =>
      b.minUrlJaccard - a.minUrlJaccard
      || b.minDomainJaccard - a.minDomainJaccard
      || b.meanUrlJaccard - a.meanUrlJaccard
      || b.meanDomainJaccard - a.meanDomainJaccard
      || compareIdArrays(a.merged, b.merged, compareKeywordIds),
    );

    const chosen = candidates[0]!;
    groups = groups.filter((_, index) => index !== chosen.aIndex && index !== chosen.bIndex);
    groups.push(chosen.merged);
    groups.sort((a, b) => compareIdArrays(a, b, compareKeywordIds));
  }

  for (const group of groups) group.sort(compareKeywordIds);
  return groups.sort((a, b) => compareIdArrays(a, b, compareKeywordIds));
}

function compareIdArrays(
  a: number[],
  b: number[],
  compareKeywordIds: (a: number, b: number) => number,
): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareKeywordIds(a[index]!, b[index]!);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function clusterCohesion(memberIds: number[], pairs: Map<string, PairwiseComparison>): ClusterCohesion {
  if (memberIds.length < 2) {
    return { pairCount: 0, urlJaccard: null, domainJaccard: null };
  }

  const urlValues: number[] = [];
  const domainValues: number[] = [];
  for (let aIndex = 0; aIndex < memberIds.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < memberIds.length; bIndex += 1) {
      const pair = pairs.get(pairKey(memberIds[aIndex]!, memberIds[bIndex]!));
      if (!pair) continue;
      urlValues.push(pairUrlJaccard(pair));
      domainValues.push(pairDomainJaccard(pair));
    }
  }

  return {
    pairCount: urlValues.length,
    urlJaccard: summarize(urlValues),
    domainJaccard: summarize(domainValues),
  };
}

function pairUrlJaccard(pair: PairwiseComparison | undefined): number {
  return pair?.urlJaccard ?? 0;
}

function pairDomainJaccard(pair: PairwiseComparison | undefined): number {
  return pair?.domainJaccard ?? pair?.jaccard ?? 0;
}

function summarize(values: number[]): ClusterCohesionSummary | null {
  if (values.length === 0) return null;
  return {
    min: Math.min(...values),
    median: median(values),
    mean: mean(values),
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

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
