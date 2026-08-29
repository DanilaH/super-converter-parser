import type { SerpResult } from '../google/serp.js';
import type { KeywordCluster, PairwiseComparison, RepresentativeQueriesConfigSnapshot } from './types.js';
import {
  defaultRepresentativeQueriesConfig,
  selectRepresentativeQueries,
  validateRepresentativeQueriesConfig,
  type RepresentativeQuerySet,
} from './representativeQueries.js';

export type BuildRepresentativeSetsInput = {
  clusters: KeywordCluster[];
  pairs: PairwiseComparison[];
  serpRows: SerpResult[];
  topN: number;
  config?: RepresentativeQueriesConfigSnapshot;
};

export function buildRepresentativeQuerySets(
  input: BuildRepresentativeSetsInput,
): RepresentativeQuerySet[] {
  if (!Number.isInteger(input.topN) || input.topN <= 0) {
    throw new Error(`Representative query SERP topN must be a positive integer, got ${input.topN}`);
  }

  const config = input.config ?? defaultRepresentativeQueriesConfig();
  validateRepresentativeQueriesConfig(config);

  const clusterIds = new Set<string>();
  for (const cluster of input.clusters) {
    if (clusterIds.has(cluster.clusterId)) {
      throw new Error(`Duplicate cluster id in representative input: ${cluster.clusterId}`);
    }
    clusterIds.add(cluster.clusterId);
  }
  const unknownOverrides = config.overrides
    .map((override) => override.clusterId)
    .filter((clusterId) => !clusterIds.has(clusterId));
  if (unknownOverrides.length > 0) {
    throw new Error(
      `Representative override references unknown cluster(s): ${unknownOverrides.join(', ')}`,
    );
  }

  const rowsByKeywordIdx = new Map<number, SerpResult[]>();
  for (const row of input.serpRows) {
    if (row.keywordIdx === undefined || row.keywordIdx === null) continue;
    const existing = rowsByKeywordIdx.get(row.keywordIdx) ?? [];
    existing.push(row);
    rowsByKeywordIdx.set(row.keywordIdx, existing);
  }

  const memberIds = new Set<number>();
  for (const cluster of input.clusters) {
    for (const member of cluster.members) {
      if (member.keywordIdx === null) {
        throw new Error(`Cluster ${cluster.clusterId} contains a historical member without source keyword identity`);
      }
      memberIds.add(member.keywordIdx);
      const organicRows = (rowsByKeywordIdx.get(member.keywordIdx) ?? [])
        .filter((row) => row.resultType === 'organic');
      if (organicRows.length === 0) {
        throw new Error(
          `Cluster ${cluster.clusterId} member ${member.keywordIdx} has no organic source SERP rows; representative evidence cannot be reconstructed safely`,
        );
      }
    }
  }

  const memberUrls = new Map<number, string[]>();
  for (const keywordIdx of memberIds) {
    const rows = rowsByKeywordIdx.get(keywordIdx) ?? [];
    memberUrls.set(
      keywordIdx,
      rows
        .filter((row) => row.resultType === 'organic')
        .sort((a, b) => a.position - b.position)
        .slice(0, input.topN)
        .map((row) => row.url),
    );
  }

  return [...input.clusters]
    .sort((a, b) => compareClusterIds(a.clusterId, b.clusterId))
    .map((cluster) => selectRepresentativeQueries({
      cluster,
      pairs: input.pairs,
      memberUrls,
      config,
    }));
}

function compareClusterIds(a: string, b: string): number {
  const aMatch = /^cluster-(\d+)$/.exec(a);
  const bMatch = /^cluster-(\d+)$/.exec(b);
  if (aMatch && bMatch) {
    const numeric = Number(aMatch[1]) - Number(bMatch[1]);
    if (numeric !== 0) return numeric;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
