export type EnrichmentModuleId = 'clusters';

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

export type EnrichmentRunRecord = {
  enrichmentId: string;
  sourceRunId: string;
  state: EnrichmentRunState;
  createdAt: string;
  updatedAt: string;
  modules: EnrichmentModuleId[];
  config: ClusteringConfig;
  sourceRunDirectory: string;
  enrichmentDirectory: string;
  error: string | null;
};

export type ClusterItemRecord = {
  enrichmentId: string;
  clusterId: string;
  status: EnrichmentItemStatus;
  source: 'serp_overlap';
  createdAt: string;
  updatedAt: string;
  requestCount: number;
  error: string | null;
  payload: string;
};

export type EnrichmentItemRecord = ClusterItemRecord;
