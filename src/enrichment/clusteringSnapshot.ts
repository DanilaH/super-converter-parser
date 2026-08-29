import type { RunStore } from '../db/store.js';
import type { ClusteredKeywordExclusion, PairwiseComparison } from './types.js';

// Persisted on the completed clusters module item. Legacy cluster runs predate
// this marker, so an empty idx-owned relation table can be distinguished from
// "v2 relations were never written" without deleting historical text-owned rows.
export const CLUSTER_KEYWORD_IDENTITY_SNAPSHOT = 'source_keyword_idx_v1';

export type PersistedClusteringRelations = {
  pairs: PairwiseComparison[];
  exclusions: ClusteredKeywordExclusion[];
};

export function loadPersistedClusteringRelations(
  store: RunStore,
  enrichmentId: string,
  snapshotPayload: string | null,
): PersistedClusteringRelations {
  const pairs = store.loadEnrichmentPairs(enrichmentId);
  const exclusions = store.loadEnrichmentExclusions(enrichmentId);

  if (snapshotPayload !== CLUSTER_KEYWORD_IDENTITY_SNAPSHOT) {
    return { pairs, exclusions };
  }

  // Raw store readers deliberately retain legacy compatibility. When the
  // current snapshot is explicitly idx-owned, null identity rows can only be
  // historical fallback rows returned because the current relation is empty.
  return {
    pairs: pairs.filter(
      (pair) => pair.keywordAIdx !== null && pair.keywordBIdx !== null,
    ),
    exclusions: exclusions.filter((row) => row.keywordIdx !== null),
  };
}
