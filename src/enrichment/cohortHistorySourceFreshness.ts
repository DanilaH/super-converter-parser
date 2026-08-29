export function assertCohortHistorySourceFreshness(input: {
  sourceRunId: string;
  currentSourceUpdatedAt: string;
  entrantSourceUpdatedAt: string;
}): void {
  const current = Date.parse(input.currentSourceUpdatedAt);
  const entrant = Date.parse(input.entrantSourceUpdatedAt);
  if (!Number.isFinite(current) || !Number.isFinite(entrant)) {
    throw new Error(`Source generation timestamps for ${input.sourceRunId} are invalid.`);
  }
  if (input.currentSourceUpdatedAt !== input.entrantSourceUpdatedAt) {
    throw new Error(
      `Source run ${input.sourceRunId} changed after the persisted entrant-cohort snapshot `
      + `(${input.entrantSourceUpdatedAt} -> ${input.currentSourceUpdatedAt}). Rebuild the upstream cohort before cohort history.`,
    );
  }
}
