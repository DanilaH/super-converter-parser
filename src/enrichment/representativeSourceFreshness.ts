export function assertRepresentativeSourceFreshness(input: {
  sourceRunId: string;
  sourceUpdatedAt: string;
  clusteringUpdatedAt: string;
}): void {
  const sourceUpdatedAt = parseTimestamp(input.sourceUpdatedAt, `source run ${input.sourceRunId} updatedAt`);
  const clusteringUpdatedAt = parseTimestamp(input.clusteringUpdatedAt, 'clusters item updatedAt');

  if (sourceUpdatedAt > clusteringUpdatedAt) {
    throw new Error(
      `Source run ${input.sourceRunId} was modified after the persisted clustering snapshot. `
      + 'Representative queries cannot mix newer SERP rows with older cluster/pair evidence; rerun clustering enrichment first.',
    );
  }
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}
