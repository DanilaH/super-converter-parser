import type { RunStore } from '../db/store.js';

type PersistedPairs = ReturnType<RunStore['loadEnrichmentPairs']>;
type PersistedExclusions = ReturnType<RunStore['loadEnrichmentExclusions']>;

export type PersistedClusteringRelations = {
  pairs: PersistedPairs;
  exclusions: PersistedExclusions;
};

export function loadPersistedClusteringRelations(
  store: RunStore,
  enrichmentId: string,
): PersistedClusteringRelations {
  const clusters = store.loadKeywordClusters(enrichmentId);
  const pairs = store.loadEnrichmentPairs(enrichmentId);
  const exclusions = store.loadEnrichmentExclusions(enrichmentId);

  // Raw store readers deliberately preserve text-owned legacy rows. A completed
  // fresh V2 snapshot is nevertheless unambiguous: it either has an idx-owned
  // cluster, or (when every keyword was excluded) an idx-owned exclusion. Pair
  // rows are also useful evidence for a non-empty current relation.
  const hasCurrentSnapshot =
    clusters.some((cluster) => cluster.canonicalKeywordIdx !== null)
    || pairs.some((pair) => pair.keywordAIdx !== null && pair.keywordBIdx !== null)
    || exclusions.some((row) => row.keywordIdx !== null);

  if (!hasCurrentSnapshot) {
    return { pairs, exclusions };
  }

  // If one V2 relation is legitimately empty, its raw loader may fall back to
  // historical rows. Once the snapshot is known to be current, null identities
  // are compatibility-only evidence and cannot become current truth again.
  return {
    pairs: pairs.filter(
      (pair) => pair.keywordAIdx !== null && pair.keywordBIdx !== null,
    ),
    exclusions: exclusions.filter((row) => row.keywordIdx !== null),
  };
}
