export type EnrichmentModuleId = 'clusters';

export const KNOWN_ENRICHMENT_MODULES: readonly EnrichmentModuleId[] = ['clusters'];

export type EnrichmentItemStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'not_attempted';

export type EnrichmentRunState =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export type EnrichmentItemSource =
  | 'serp_overlap'
  | 'shortlist'
  | 'config';

export type EnrichmentCacheStatus =
  | 'hit'
  | 'miss'
  | 'expired'
  | 'refreshed'
  | 'none';

export type ClusterEdgeRule = {
  minSharedDomains: number;
  minJaccard: number;
};

export type ClusterEvidence = {
  sharedDomains: string[];
  intersectionCount: number;
  unionCount: number;
  jaccard: number;
};

export type ClusterMember = {
  keyword: string;
  normalizedKeyword: string;
  volume: number | null;
  serpSize: number;
};

export type KeywordCluster = {
  clusterId: string;
  canonicalKeyword: string;
  members: ClusterMember[];
  representativeDomains: string[];
  medianVolume: number | null;
  averageVolume: number | null;
  memberCount: number;
};

export type ClusteringConfig = {
  topN: number;
  edgeRule: ClusterEdgeRule;
  algorithmVersion: string;
};

export type EnrichmentModuleConfig = {
  clusters?: ClusteringConfig;
};

export type EnrichmentRunRecord = {
  enrichmentId: string;
  sourceRunId: string;
  state: EnrichmentRunState;
  createdAt: string;
  updatedAt: string;
  modules: EnrichmentModuleId[];
  config: EnrichmentModuleConfig;
  sourceRunDirectory: string;
  enrichmentDirectory: string;
  shortlistKeywords: string[];
  error: string | null;
};

export type EnrichmentItemRecord = {
  enrichmentId: string;
  itemId: string;
  module: EnrichmentModuleId;
  status: EnrichmentItemStatus;
  source: EnrichmentItemSource;
  createdAt: string;
  updatedAt: string;
  requestCount: number;
  fetchedAt: string | null;
  cacheStatus: EnrichmentCacheStatus;
  error: string | null;
  payload: string | null;
};

export type ClusteredKeywordExclusion = {
  keyword: string;
  normalizedKeyword: string;
  reason: 'no_serp' | 'no_domains' | 'shortlist_mismatch';
  serpSize: number;
};

export type PairwiseComparison = {
  keywordA: string;
  keywordB: string;
  intersectionCount: number;
  unionCount: number;
  jaccard: number;
  sharedDomains: string[];
  isEdge: boolean;
};

export type EnrichmentResult = {
  enrichmentId: string;
  clusters: KeywordCluster[];
  pairs: PairwiseComparison[];
  exclusions: ClusteredKeywordExclusion[];
  config: EnrichmentModuleConfig;
  algorithmVersion: string;
  inputCount: number;
  excludedCount: number;
  edgeCount: number;
};
