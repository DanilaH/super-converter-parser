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

export const IMPLEMENTED_ENRICHMENT_MODULES = ['clusters', 'query_suggestions', 'domain_age', 'pages', 'site_structure'] as const satisfies readonly EnrichmentModuleId[];

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
  | 'ahrefs'
  | 'cache'
  | 'checkpoint';

export type EnrichmentCacheStatus =
  | 'hit'
  | 'source_run'
  | 'miss'
  | 'expired'
  | 'refreshed'
  | 'partial'
  | 'none';

export type ClusterEdgeRule = {
  minSharedDomains: number;
  // Historical field name retained for persisted V1 config compatibility. In
  // clustering v2 this is explicitly the domain-Jaccard threshold.
  minJaccard: number;
  // Optional only so historical V1 config JSON remains readable. Fresh V2
  // config always persists concrete values.
  minSharedUrls?: number;
  minUrlJaccard?: number;
};

export type ClusterPairClassification =
  | 'strong'
  | 'domain_only'
  | 'url_only'
  | 'weak'
  | 'none'
  | 'legacy_domain_only';

export type ClusterEvidence = {
  sharedDomains: string[];
  intersectionCount: number;
  unionCount: number;
  jaccard: number;
  sharedUrls?: string[];
  urlIntersectionCount?: number;
  urlUnionCount?: number;
  urlJaccard?: number;
  classification?: ClusterPairClassification;
};

export type ClusterCohesionSummary = {
  min: number;
  median: number;
  mean: number;
};

export type ClusterCohesion = {
  pairCount: number;
  urlJaccard: ClusterCohesionSummary | null;
  domainJaccard: ClusterCohesionSummary | null;
};

// Source keyword identity is (sourceRunId, keywordIdx). The enrichment run
// already persists sourceRunId, so keywordIdx is the durable relational key.
// It is nullable only when reading historical enrichment rows that predate
// V2.1; every new clustering write carries a concrete index.
export type ClusterMember = {
  keywordIdx: number | null;
  keyword: string;
  normalizedKeyword: string;
  volume: number | null;
  serpSize: number;
};

export type KeywordCluster = {
  clusterId: string;
  canonicalKeywordIdx: number | null;
  canonicalKeyword: string;
  members: ClusterMember[];
  representativeDomains: string[];
  medianVolume: number | null;
  averageVolume: number | null;
  memberCount: number;
  // Missing only on historical V1 rows loaded from persistence.
  cohesion?: ClusterCohesion | null;
};

export type ClusteringConfig = {
  topN: number;
  edgeRule: ClusterEdgeRule;
  algorithmVersion: string;
  urlIdentityVersion?: string;
  groupingRule?: 'connected_components' | 'complete_link';
};

export type RepresentativeQueryOverrideConfig = {
  clusterId: string;
  keywordIds: number[];
  reason: string;
};

export type RepresentativeQueriesConfigSnapshot = {
  targetCount: number;
  overrides: RepresentativeQueryOverrideConfig[];
  setVersion: string;
};

export type RepresentativeQueryRunConfigSnapshot = RepresentativeQueriesConfigSnapshot & {
  // PR-05 operates on explicitly chosen finalist clusters. `--all-clusters`
  // resolves to the concrete current ids before persistence so downstream work
  // never has to reinterpret what "all" meant later.
  selectedClusterIds: string[];
};

type ReservedModuleConfig = Record<string, unknown>;

export type QuerySuggestionsConfig = {
  sources: QuerySuggestionSource[];
  maxSuggestionsPerSource: number;
  maxParents: number;
  rateLimitMinDelayMs: number;
  rateLimitMaxDelayMs: number;
  algorithmVersion: string;
};

export type DomainSelectionConfig = {
  algorithmVersion: string;
};

export type EnrichmentModuleConfig = {
  clusters?: ClusteringConfig;
  representative_queries?: RepresentativeQueryRunConfigSnapshot;
  pages?: ReservedModuleConfig;
  site_structure?: ReservedModuleConfig;
  query_suggestions?: QuerySuggestionsConfig;
  domain_age?: ReservedModuleConfig;
  domain_selection?: DomainSelectionConfig;
  page_backlinks?: ReservedModuleConfig;
  organic_snapshot?: ReservedModuleConfig;
  http?: ReservedModuleConfig;
  cache?: ReservedModuleConfig;
  shortlist?: string[];
};

// One collected suggestion row. Dedup is on normalizedSuggestion only; every
// (parent keyword identity, source) occurrence is retained in `occurrences`.
// parentKeywordIdx is nullable only for historical persisted occurrences.
export type QuerySuggestion = {
  parentKeywordIdx: number | null;
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
  // Every (parent keyword identity, source) occurrence of this normalized
  // suggestion, retained even when suggestion identity collides across parents.
  occurrences: QuerySuggestionOccurrence[];
};

// One occurrence of a suggestion under a specific source keyword/source. New
// writes own the relation by parentKeywordIdx; normalizedParent remains useful
// for display, semantic lookup, and cross-run cache identity.
export type QuerySuggestionOccurrence = {
  parentKeywordIdx: number | null;
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
  keywordIdx: number | null;
  keyword: string;
  normalizedKeyword: string;
  reason: 'no_serp' | 'no_domains' | 'shortlist_mismatch';
  serpSize: number;
};

export type PairwiseComparison = {
  keywordAIdx: number | null;
  keywordBIdx: number | null;
  keywordA: string;
  keywordB: string;
  // V1 compatibility aliases: domain intersection / union / Jaccard.
  intersectionCount: number;
  unionCount: number;
  jaccard: number;
  sharedDomains: string[];
  // V2 additive evidence. Missing only on historical persisted V1 rows.
  sharedUrls?: string[];
  urlIntersectionCount?: number;
  urlUnionCount?: number;
  urlJaccard?: number;
  domainIntersectionCount?: number;
  domainUnionCount?: number;
  domainJaccard?: number;
  classification?: ClusterPairClassification;
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
