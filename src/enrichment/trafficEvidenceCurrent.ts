import type { EntrantCohort } from './entrantCohort.js';
import {
  compareTrafficSnapshotsForOutput,
  normalizeTrafficSnapshots,
  projectTrafficEvidence,
  type TrafficEvidencePolicy,
  type TrafficEvidenceProjection,
  type TrafficSnapshot,
  type TrafficSnapshotInput,
} from './trafficEvidence.js';

export type StaleTrafficTarget = {
  reason: 'target_cluster_not_current';
  snapshot: TrafficSnapshot;
};

export type CurrentTrafficEvidenceProjection = {
  importedSnapshotCount: number;
  currentTargetSnapshotCount: number;
  staleTargetSnapshotCount: number;
  projection: TrafficEvidenceProjection;
  staleTargets: StaleTrafficTarget[];
};

export function projectCurrentTrafficEvidence(input: {
  importedSnapshots: TrafficSnapshot[];
  cohorts: EntrantCohort[];
  policy: TrafficEvidencePolicy;
}): CurrentTrafficEvidenceProjection {
  const cohortById = new Map<string, EntrantCohort>();
  for (const cohort of input.cohorts) {
    if (cohortById.has(cohort.clusterId)) {
      throw new Error(`Duplicate entrant cohort cluster ${cohort.clusterId}`);
    }
    cohortById.set(cohort.clusterId, cohort);
  }

  const currentSnapshots: TrafficSnapshot[] = [];
  const staleTargets: StaleTrafficTarget[] = [];
  for (const imported of input.importedSnapshots) {
    const cohort = cohortById.get(imported.targetClusterId);
    if (!cohort) {
      staleTargets.push({ reason: 'target_cluster_not_current', snapshot: imported });
      continue;
    }
    const [revalidated] = normalizeTrafficSnapshots({
      rows: [snapshotToInput(imported)],
      cohorts: [cohort],
    });
    if (!revalidated) throw new Error('Traffic target revalidation produced no snapshot');
    if (revalidated.normalizedEntity !== imported.normalizedEntity) {
      throw new Error(
        `Traffic snapshot normalization drift for ${imported.targetClusterId} ${imported.scope} ${imported.entity}: `
        + `${imported.normalizedEntity} -> ${revalidated.normalizedEntity}`,
      );
    }
    currentSnapshots.push(revalidated);
  }

  staleTargets.sort((a, b) => compareTrafficSnapshotsForOutput(a.snapshot, b.snapshot));

  return {
    importedSnapshotCount: input.importedSnapshots.length,
    currentTargetSnapshotCount: currentSnapshots.length,
    staleTargetSnapshotCount: staleTargets.length,
    projection: projectTrafficEvidence({ snapshots: currentSnapshots, policy: input.policy }),
    staleTargets,
  };
}

function snapshotToInput(snapshot: TrafficSnapshot): TrafficSnapshotInput {
  return {
    targetClusterId: snapshot.targetClusterId,
    scope: snapshot.scope,
    entity: snapshot.entity,
    observedAt: snapshot.observedAt,
    providerDataDate: snapshot.providerDataDate,
    market: snapshot.market,
    source: snapshot.source,
    organicTraffic: snapshot.organicTraffic,
    trafficValue: snapshot.trafficValue,
    trafficValueCurrency: snapshot.trafficValueCurrency,
    provenance: snapshot.provenance,
  };
}
