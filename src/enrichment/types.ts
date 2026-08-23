export const KNOWN_ENRICHMENT_MODULES = [
  'clusters',
  'pages',
  'site_structure',
  'query_suggestions',
  'domain_age',
  'page_backlinks',
  'organic_snapshot',
] as const;

export type EnrichmentModuleId = (typeof KNOWN_ENRICHMENT_MODULES)[number];

export const IMPLEMENTED_ENRICHMENT_MODULES = ['clusters', 'query_suggestions'] as const satisfies readonly EnrichmentModuleId[];

// Factual Google query-language sources for the query_suggestions module. Each
// keeps its own raw text and provenance; volume/CPC are intentionally null for
// every Google-sourced suggestion because this module never invents demand.
export const QUERY_SUGGESTION_SOURCES = [
  'surfer_related',
  'google_autocomplete',
  'google_related_search',
  'google_paa',
] as const;

export type QuerySuggestionSource = (typeof QUERY_SUGGESTION_SOURCES)[number];

export type QuerySuggestionCollectionStatus = 'ok' | 'empty' | 'unavailable' | 'error';

// Version stamps the suggestion collection contract. Bump when a parser or the
// dedup/identity logic changes so cached entries are invalidated deliberately.
export const QUERY_SUGGESTION_PARSER_VERSION = '1.0.0';

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
  | 'config'
  | 'http'
  | 'google'
  | 'surfer'
  | 'rdap'
  | 'first_seen'
  | 'ahrefs';

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

type ReservedModuleConfig = Record<string, unknown>;

export type QuerySuggestionsConfig = {
  sources: QuerySuggestionSource[];
  maxSuggestionsPerSource: number;
  rateLimitMinDelayMs: number;
  rateLimitMaxDelayMs: number;
  algorithmVersion: string;
};

export type EnrichmentModuleConfig = {
  clusters?: ClusteringConfig;
  pages?: ReservedModuleConfig;
  site_structure?: ReservedModuleConfig;
  query_suggestions?: QuerySuggestionsConfig;
  domain_age?: ReservedModuleConfig;
  page_backlinks?: ReservedModuleConfig;
  organic_snapshot?: ReservedModuleConfig;
};

// One collected suggestion row. Dedup is on normalizedSuggestion only; every
// (parentKeyword, source) occurrence is retained in `occurrences`.
export type QuerySuggestion = {
  parentKeyword: string;
  normalizedParent: string;
  source: QuerySuggestionSource;
  rawText: string;
  normalizedSuggestion: string;
  ordinal: number | null;
  // Real volume/CPC only when a genuine source supplies them (surfer_related).
  // Google-sourced suggestions keep both null — this module never invents them.
  volume: number | null;
  cpc: number | null;
  market: string;
  hl: string;
  gl: string;
  parserVersion: string;
  collectionStatus: QuerySuggestionCollectionStatus;
  // Every (parentKeyword, source) occurrence of this normalized suggestion,
  // retained even when the identity collides across parents/sources.
  occurrences: QuerySuggestionOccurrence[];
};

// One occurrence of a suggestion under a specific parent/source, preserved even
// when the normalized identity collides across parents/sources.
export type QuerySuggestionOccurrence = {
  parentKeyword: string;
  normalizedParent: string;
  source: QuerySuggestionSource;
  market: string;
  hl: string;
  gl: string;
  parserVersion: string;
  collectionStatus: QuerySuggestionCollectionStatus;
};

export type QuerySuggestionPerSourceStatus = {
  source: QuerySuggestionSource;
  status: QuerySuggestionCollectionStatus;
  collected: number;
  error: string | null;
};

// Shared run/control types used by every enrichment module (moved here so module
// files do not import the engine and create a cycle).
export type EnrichmentLogger = (line: string) => void;

export type CancellationSignal = {
  cancelled: boolean;
};

export const NEVER_CANCELLED: CancellationSignal = Object.freeze({ cancelled: false });

export class EnrichmentCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'EnrichmentCancelledError';
  }
}

export type QuerySuggestionResult = {
  enrichmentId: string;
  suggestions: QuerySuggestion[];
  perSourceStatus: QuerySuggestionPerSourceStatus[];
  inputCount: number;
  emptyCount: number;
  errorCount: number;
  sourceStats: Record<QuerySuggestionSource, { ok: number; empty: number; unavailable: number; error: number }>;
  algorithmVersion: string;
  config: QuerySuggestionsConfig;
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
