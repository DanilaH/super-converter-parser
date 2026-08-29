import type {
  KeywordCluster,
  PairwiseComparison,
  RepresentativeQueriesConfigSnapshot,
  RepresentativeQueryOverrideConfig,
} from './types.js';
import { clusteringUrlIdentity } from './urlIdentity.js';

export const REPRESENTATIVE_QUERY_SET_VERSION = '1.0.0';
export const DEFAULT_REPRESENTATIVE_QUERY_COUNT = 5;
export const MIN_REPRESENTATIVE_QUERY_COUNT = 3;
export const MAX_REPRESENTATIVE_QUERY_COUNT = 10;

export type RepresentativeQuerySelectionReason =
  | 'medoid'
  | 'high_demand'
  | 'coverage_expansion'
  | 'manual_override';

export type RepresentativeQueryOverride = RepresentativeQueryOverrideConfig;
export type RepresentativeQueriesConfig = RepresentativeQueriesConfigSnapshot;

export type RepresentativeQuery = {
  keywordIdx: number;
  keyword: string;
  normalizedKeyword: string;
  volume: number | null;
  selectionReason: RepresentativeQuerySelectionReason;
  coverageGain: number;
};

export type RepresentativeQuerySet = {
  clusterId: string;
  setVersion: string;
  representativeKeywordIds: number[];
  representatives: RepresentativeQuery[];
  targetCount: number;
  clusterUrlCount: number;
  coveredUrlCount: number;
  manualOverride: boolean;
  manualOverrideReason: string | null;
};

export type RepresentativeSelectionInput = {
  cluster: KeywordCluster;
  pairs: PairwiseComparison[];
  memberUrls: ReadonlyMap<number, readonly string[]>;
  config?: Partial<RepresentativeQueriesConfig>;
};

export function defaultRepresentativeQueriesConfig(): RepresentativeQueriesConfig {
  return {
    targetCount: DEFAULT_REPRESENTATIVE_QUERY_COUNT,
    overrides: [],
    setVersion: REPRESENTATIVE_QUERY_SET_VERSION,
  };
}

export function validateRepresentativeQueriesConfig(config: RepresentativeQueriesConfig): void {
  if (!Number.isInteger(config.targetCount)) {
    throw new Error(`Representative query targetCount must be an integer, got ${config.targetCount}`);
  }
  if (config.targetCount < MIN_REPRESENTATIVE_QUERY_COUNT || config.targetCount > MAX_REPRESENTATIVE_QUERY_COUNT) {
    throw new Error(
      `Representative query targetCount must be in [${MIN_REPRESENTATIVE_QUERY_COUNT}, ${MAX_REPRESENTATIVE_QUERY_COUNT}], got ${config.targetCount}`,
    );
  }
  if (config.setVersion !== REPRESENTATIVE_QUERY_SET_VERSION) {
    throw new Error(
      `Unsupported representative query set version ${config.setVersion}; this build requires ${REPRESENTATIVE_QUERY_SET_VERSION}`,
    );
  }

  const seenClusters = new Set<string>();
  for (const override of config.overrides) {
    if (override.clusterId.trim() === '') throw new Error('Representative override clusterId cannot be empty');
    if (seenClusters.has(override.clusterId)) {
      throw new Error(`Duplicate representative override for ${override.clusterId}`);
    }
    seenClusters.add(override.clusterId);
    if (override.reason.trim() === '') {
      throw new Error(`Representative override for ${override.clusterId} requires a non-empty reason`);
    }
    if (override.keywordIds.length === 0 || override.keywordIds.length > MAX_REPRESENTATIVE_QUERY_COUNT) {
      throw new Error(
        `Representative override for ${override.clusterId} must contain 1-${MAX_REPRESENTATIVE_QUERY_COUNT} keyword ids`,
      );
    }
    if (new Set(override.keywordIds).size !== override.keywordIds.length) {
      throw new Error(`Representative override for ${override.clusterId} contains duplicate keyword ids`);
    }
    if (override.keywordIds.some((id) => !Number.isInteger(id) || id < 0)) {
      throw new Error(`Representative override for ${override.clusterId} contains an invalid keyword id`);
    }
  }
}

export function selectRepresentativeQueries(input: RepresentativeSelectionInput): RepresentativeQuerySet {
  const config: RepresentativeQueriesConfig = {
    ...defaultRepresentativeQueriesConfig(),
    ...input.config,
    overrides: input.config?.overrides ?? [],
  };
  validateRepresentativeQueriesConfig(config);

  const members = input.cluster.members.map((member) => {
    if (member.keywordIdx === null) {
      throw new Error(`Cluster ${input.cluster.clusterId} contains a historical member without source keyword identity`);
    }
    return { ...member, keywordIdx: member.keywordIdx };
  });
  if (members.length === 0) {
    throw new Error(`Cluster ${input.cluster.clusterId} has no members`);
  }
  if (new Set(members.map((member) => member.keywordIdx)).size !== members.length) {
    throw new Error(`Cluster ${input.cluster.clusterId} contains duplicate source keyword ids`);
  }

  const memberById = new Map(members.map((member) => [member.keywordIdx, member]));
  const urlSets = new Map<number, Set<string>>();
  const clusterUrls = new Set<string>();
  for (const member of members) {
    const identities = new Set<string>();
    for (const rawUrl of input.memberUrls.get(member.keywordIdx) ?? []) {
      const identity = clusteringUrlIdentity(rawUrl);
      if (identity === null) continue;
      identities.add(identity);
      clusterUrls.add(identity);
    }
    urlSets.set(member.keywordIdx, identities);
  }

  const pairMap = new Map<string, PairwiseComparison>();
  for (const pair of input.pairs) {
    if (pair.keywordAIdx === null || pair.keywordBIdx === null) continue;
    const key = pairKey(pair.keywordAIdx, pair.keywordBIdx);
    if (pairMap.has(key)) {
      throw new Error(
        `Duplicate pair evidence for keyword ids ${Math.min(pair.keywordAIdx, pair.keywordBIdx)} and ${Math.max(pair.keywordAIdx, pair.keywordBIdx)}`,
      );
    }
    pairMap.set(key, pair);
  }
  assertCompletePairEvidence(input.cluster.clusterId, members, pairMap);

  const automaticTargetCount = Math.min(config.targetCount, members.length);
  const override = config.overrides.find((row) => row.clusterId === input.cluster.clusterId);
  if (override) {
    for (const keywordIdx of override.keywordIds) {
      if (!memberById.has(keywordIdx)) {
        throw new Error(
          `Representative override for ${input.cluster.clusterId} references keyword ${keywordIdx}, which is not a cluster member`,
        );
      }
    }
    return buildSet(
      input.cluster.clusterId,
      config.setVersion,
      override.keywordIds,
      memberById,
      urlSets,
      override.keywordIds.length,
      clusterUrls.size,
      true,
      override.reason,
      () => 'manual_override',
    );
  }

  const medoid = [...members].sort((a, b) => {
    const centralityA = centrality(a.keywordIdx, members, pairMap);
    const centralityB = centrality(b.keywordIdx, members, pairMap);
    return centralityB.url - centralityA.url
      || centralityB.domain - centralityA.domain
      || a.keywordIdx - b.keywordIdx;
  })[0]!;

  const selected: Array<{ keywordIdx: number; reason: RepresentativeQuerySelectionReason }> = [
    { keywordIdx: medoid.keywordIdx, reason: 'medoid' },
  ];

  if (selected.length < automaticTargetCount) {
    const distinctDemandCandidates = unselectedCandidates(members, selected)
      .filter((member) => member.normalizedKeyword !== medoid.normalizedKeyword)
      .filter((member) => member.volume !== null)
      .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || a.keywordIdx - b.keywordIdx);
    const highDemand = distinctDemandCandidates[0];
    if (highDemand) selected.push({ keywordIdx: highDemand.keywordIdx, reason: 'high_demand' });
  }

  while (selected.length < automaticTargetCount) {
    const covered = coverageFor(selected.map((row) => row.keywordIdx), urlSets);
    const candidates = preferredDistinctCandidates(members, selected);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => {
      const gainA = coverageGain(urlSets.get(a.keywordIdx) ?? new Set(), covered);
      const gainB = coverageGain(urlSets.get(b.keywordIdx) ?? new Set(), covered);
      return gainB - gainA || a.keywordIdx - b.keywordIdx;
    });
    selected.push({ keywordIdx: candidates[0]!.keywordIdx, reason: 'coverage_expansion' });
  }

  return buildSet(
    input.cluster.clusterId,
    config.setVersion,
    selected.map((row) => row.keywordIdx),
    memberById,
    urlSets,
    automaticTargetCount,
    clusterUrls.size,
    false,
    null,
    (keywordIdx) => selected.find((row) => row.keywordIdx === keywordIdx)!.reason,
  );
}

function assertCompletePairEvidence(
  clusterId: string,
  members: Array<{ keywordIdx: number }>,
  pairMap: ReadonlyMap<string, PairwiseComparison>,
): void {
  for (let aIndex = 0; aIndex < members.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < members.length; bIndex += 1) {
      const a = members[aIndex]!.keywordIdx;
      const b = members[bIndex]!.keywordIdx;
      const pair = pairMap.get(pairKey(a, b));
      if (
        !pair
        || pair.urlJaccard === undefined
        || pair.domainJaccard === undefined
      ) {
        throw new Error(
          `Cluster ${clusterId} is missing clustering-v2 pair evidence for keyword ids ${Math.min(a, b)} and ${Math.max(a, b)}`,
        );
      }
    }
  }
}

function buildSet(
  clusterId: string,
  setVersion: string,
  keywordIds: number[],
  memberById: ReadonlyMap<number, { keywordIdx: number; keyword: string; normalizedKeyword: string; volume: number | null }>,
  urlSets: ReadonlyMap<number, Set<string>>,
  targetCount: number,
  clusterUrlCount: number,
  manualOverride: boolean,
  manualOverrideReason: string | null,
  reasonFor: (keywordIdx: number) => RepresentativeQuerySelectionReason,
): RepresentativeQuerySet {
  const covered = new Set<string>();
  const representatives: RepresentativeQuery[] = [];
  for (const keywordIdx of keywordIds) {
    const member = memberById.get(keywordIdx)!;
    const urls = urlSets.get(keywordIdx) ?? new Set<string>();
    const gain = coverageGain(urls, covered);
    for (const url of urls) covered.add(url);
    representatives.push({
      keywordIdx,
      keyword: member.keyword,
      normalizedKeyword: member.normalizedKeyword,
      volume: member.volume,
      selectionReason: reasonFor(keywordIdx),
      coverageGain: gain,
    });
  }

  return {
    clusterId,
    setVersion,
    representativeKeywordIds: representatives.map((row) => row.keywordIdx),
    representatives,
    targetCount,
    clusterUrlCount,
    coveredUrlCount: covered.size,
    manualOverride,
    manualOverrideReason,
  };
}

function centrality(
  keywordIdx: number,
  members: Array<{ keywordIdx: number }>,
  pairMap: ReadonlyMap<string, PairwiseComparison>,
): { url: number; domain: number } {
  let url = 0;
  let domain = 0;
  for (const other of members) {
    if (other.keywordIdx === keywordIdx) continue;
    const pair = pairMap.get(pairKey(keywordIdx, other.keywordIdx))!;
    url += pair.urlJaccard!;
    domain += pair.domainJaccard!;
  }
  return { url, domain };
}

function unselectedCandidates<T extends { keywordIdx: number }>(
  members: T[],
  selected: Array<{ keywordIdx: number }>,
): T[] {
  const selectedIds = new Set(selected.map((row) => row.keywordIdx));
  return members.filter((member) => !selectedIds.has(member.keywordIdx));
}

function preferredDistinctCandidates<T extends { keywordIdx: number; normalizedKeyword: string }>(
  members: T[],
  selected: Array<{ keywordIdx: number }>,
): T[] {
  const remaining = unselectedCandidates(members, selected);
  const selectedIds = new Set(selected.map((row) => row.keywordIdx));
  const selectedNormalized = new Set(
    members.filter((member) => selectedIds.has(member.keywordIdx)).map((member) => member.normalizedKeyword),
  );
  const distinct = remaining.filter((member) => !selectedNormalized.has(member.normalizedKeyword));
  return distinct.length > 0 ? distinct : remaining;
}

function coverageFor(ids: number[], urlSets: ReadonlyMap<number, Set<string>>): Set<string> {
  const covered = new Set<string>();
  for (const id of ids) {
    for (const url of urlSets.get(id) ?? []) covered.add(url);
  }
  return covered;
}

function coverageGain(urls: ReadonlySet<string>, covered: ReadonlySet<string>): number {
  let gain = 0;
  for (const url of urls) {
    if (!covered.has(url)) gain += 1;
  }
  return gain;
}

function pairKey(a: number, b: number): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}
