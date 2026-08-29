import { renderCsv } from '../exports/csv.js';
import { writeTextAtomic } from '../runs/run.js';
import type { RepresentativeQueryRunConfigSnapshot } from './types.js';
import type { RepresentativeQuerySet } from './representativeQueries.js';

export type RepresentativeQueryOutputOptions = {
  enrichmentId: string;
  sourceRunId: string;
  config: RepresentativeQueryRunConfigSnapshot;
  sets: RepresentativeQuerySet[];
  revision: number;
  changed: boolean;
  previousSets?: RepresentativeQuerySet[] | undefined;
};

export function writeRepresentativeQueriesCsv(
  outputPath: string,
  options: Pick<RepresentativeQueryOutputOptions, 'sets' | 'revision' | 'previousSets'>,
): Promise<void> {
  const previousByCluster = new Map(
    (options.previousSets ?? []).map((set) => [set.clusterId, set]),
  );
  const rows: string[][] = [[
    'cluster_id',
    'revision',
    'changed_from_previous',
    'previous_representative_keyword_ids',
    'set_version',
    'target_count',
    'representative_keyword_ids',
    'representative_keywords',
    'selection_reasons',
    'coverage_gains',
    'covered_url_count',
    'cluster_url_count',
    'coverage_percent',
    'manual_override',
    'manual_override_reason',
  ]];

  for (const set of options.sets) {
    const previous = previousByCluster.get(set.clusterId);
    rows.push([
      set.clusterId,
      String(options.revision),
      previous === undefined ? '' : String(!sameSet(previous, set)),
      previous?.representativeKeywordIds.join(';') ?? '',
      set.setVersion,
      String(set.targetCount),
      set.representativeKeywordIds.join(';'),
      set.representatives.map((row) => row.keyword).join('; '),
      set.representatives.map((row) => row.selectionReason).join(';'),
      set.representatives.map((row) => String(row.coverageGain)).join(';'),
      String(set.coveredUrlCount),
      String(set.clusterUrlCount),
      coveragePercent(set),
      set.manualOverride ? 'true' : 'false',
      set.manualOverrideReason ?? '',
    ]);
  }

  return writeTextAtomic(outputPath, renderCsv(rows), 'representative queries CSV');
}

export function writeRepresentativeQueriesJson(
  outputPath: string,
  options: RepresentativeQueryOutputOptions,
): Promise<void> {
  const previousByCluster = new Map(
    (options.previousSets ?? []).map((set) => [set.clusterId, set]),
  );
  const payload = {
    enrichmentId: options.enrichmentId,
    sourceRunId: options.sourceRunId,
    revision: options.revision,
    changed: options.changed,
    config: options.config,
    clusterCount: options.sets.length,
    sets: options.sets.map((set) => {
      const previous = previousByCluster.get(set.clusterId);
      return {
        ...set,
        changedFromPrevious: previous === undefined ? null : !sameSet(previous, set),
        previousRepresentativeKeywordIds: previous?.representativeKeywordIds ?? null,
        coveragePercent: set.clusterUrlCount === 0
          ? null
          : (set.coveredUrlCount / set.clusterUrlCount) * 100,
      };
    }),
  };
  return writeTextAtomic(
    outputPath,
    JSON.stringify(payload, null, 2) + '\n',
    'representative queries JSON',
  );
}

function sameSet(a: RepresentativeQuerySet, b: RepresentativeQuerySet): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function coveragePercent(set: RepresentativeQuerySet): string {
  if (set.clusterUrlCount === 0) return '';
  return ((set.coveredUrlCount / set.clusterUrlCount) * 100).toFixed(2);
}
