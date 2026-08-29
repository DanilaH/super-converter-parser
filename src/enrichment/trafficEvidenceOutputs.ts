import type { TrafficImportRecord } from '../db/trafficEvidence.js';
import { trafficSnapshotId } from '../db/trafficEvidence.js';
import { renderCsv } from '../exports/csv.js';
import { writeTextAtomic } from '../runs/run.js';
import type { TrafficEvidencePolicy, TrafficSnapshot, TrafficTargetValidation } from './trafficEvidence.js';
import type { CurrentTrafficEvidenceProjection } from './trafficEvidenceCurrent.js';

export type TrafficEvidenceArtifact = {
  version: string;
  enrichmentId: string;
  sourceRunId: string;
  currentEntrantFingerprint: string;
  policy: TrafficEvidencePolicy;
  imports: TrafficImportRecord[];
  current: CurrentTrafficEvidenceProjection;
};

export function writeTrafficEvidenceCsv(
  outputPath: string,
  artifact: TrafficEvidenceArtifact,
): Promise<void> {
  const rows: string[][] = [[
    'snapshot_id',
    'target_cluster_id',
    'scope',
    'entity',
    'normalized_entity',
    'provider_data_date',
    'observed_at',
    'market',
    'source',
    'organic_traffic',
    'traffic_value',
    'traffic_value_currency',
    'provenance',
    'import_target_status',
    'import_target_reason',
    'current_target_status',
    'current_target_reason',
    'imported_against_entrant_fingerprint',
    'current_entrant_fingerprint',
    'imported_at',
  ]];

  const currentById = currentSnapshotMap(artifact.current);
  const staleIds = new Set(
    artifact.current.staleTargets.map((target) => trafficSnapshotId(target.snapshot)),
  );

  for (const record of artifact.imports) {
    const current = currentById.get(record.snapshotId);
    const currentStatus = current
      ? current.targetValidation.status
      : staleIds.has(record.snapshotId)
        ? 'stale_target'
        : 'unavailable';
    const currentReason = current
      ? current.targetValidation.reason ?? ''
      : staleIds.has(record.snapshotId)
        ? 'target_cluster_not_current'
        : 'current_projection_missing';
    rows.push([
      record.snapshotId,
      record.snapshot.targetClusterId,
      record.snapshot.scope,
      record.snapshot.entity,
      record.snapshot.normalizedEntity,
      record.snapshot.providerDataDate,
      record.snapshot.observedAt,
      record.snapshot.market,
      record.snapshot.source,
      nullableNumber(record.snapshot.organicTraffic),
      nullableNumber(record.snapshot.trafficValue),
      record.snapshot.trafficValueCurrency ?? '',
      record.snapshot.provenance,
      record.snapshot.targetValidation.status,
      record.snapshot.targetValidation.reason ?? '',
      currentStatus,
      currentReason,
      record.entrantFingerprint,
      artifact.currentEntrantFingerprint,
      record.importedAt,
    ]);
  }
  return writeTextAtomic(outputPath, renderCsv(rows), 'traffic evidence CSV');
}

export function writeTrafficVelocityCsv(
  outputPath: string,
  current: CurrentTrafficEvidenceProjection,
): Promise<void> {
  const rows: string[][] = [[
    'target_cluster_id',
    'scope',
    'normalized_entity',
    'market',
    'source',
    'from_provider_data_date',
    'to_provider_data_date',
    'elapsed_days',
    'organic_traffic_previous',
    'organic_traffic_current',
    'organic_traffic_absolute_delta',
    'organic_traffic_percent_delta',
    'low_base_warning',
    'traffic_value_previous',
    'traffic_value_current',
    'traffic_value_absolute_delta',
    'traffic_value_percent_delta',
    'traffic_value_currency',
    'warnings',
  ]];

  for (const history of current.projection.histories) {
    for (const velocity of history.velocities) {
      rows.push([
        history.targetClusterId,
        history.scope,
        history.normalizedEntity,
        history.market,
        history.source,
        velocity.fromProviderDataDate,
        velocity.toProviderDataDate,
        String(velocity.elapsedDays),
        nullableNumber(velocity.organicTraffic?.previous ?? null),
        nullableNumber(velocity.organicTraffic?.current ?? null),
        nullableNumber(velocity.organicTraffic?.absoluteDelta ?? null),
        nullableNumber(velocity.organicTraffic?.percentDelta ?? null),
        velocity.organicTraffic === null ? '' : String(velocity.organicTraffic.lowBaseWarning),
        nullableNumber(velocity.trafficValue?.previous ?? null),
        nullableNumber(velocity.trafficValue?.current ?? null),
        nullableNumber(velocity.trafficValue?.absoluteDelta ?? null),
        nullableNumber(velocity.trafficValue?.percentDelta ?? null),
        velocity.trafficValue?.currency ?? '',
        velocity.warnings.join('|'),
      ]);
    }
  }
  return writeTextAtomic(outputPath, renderCsv(rows), 'traffic velocity CSV');
}

export function writeTrafficEvidenceJson(
  outputPath: string,
  artifact: TrafficEvidenceArtifact,
): Promise<void> {
  return writeTextAtomic(
    outputPath,
    JSON.stringify(artifact, null, 2) + '\n',
    'traffic evidence JSON',
  );
}

function currentSnapshotMap(current: CurrentTrafficEvidenceProjection): Map<string, TrafficSnapshot> {
  const snapshots = [
    ...current.projection.histories.flatMap((history) => history.snapshots),
    ...current.projection.mismatchedSnapshots,
  ];
  return new Map(snapshots.map((snapshot) => [trafficSnapshotId(snapshot), snapshot]));
}

function nullableNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

export function targetValidationLabel(validation: TrafficTargetValidation): string {
  return validation.reason === null
    ? validation.status
    : `${validation.status}:${validation.reason}`;
}
