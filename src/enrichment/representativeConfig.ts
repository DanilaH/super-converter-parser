import type {
  RepresentativeQueryOverrideConfig,
  RepresentativeQueryRunConfigSnapshot,
} from './types.js';
import {
  REPRESENTATIVE_QUERY_SET_VERSION,
  defaultRepresentativeQueriesConfig,
  validateRepresentativeQueriesConfig,
} from './representativeQueries.js';

export function parseRepresentativeOverridesJson(
  content: string,
  sourceLabel: string = 'representative override JSON',
): RepresentativeQueryOverrideConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${sourceLabel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${sourceLabel} must contain a JSON array`);
  }

  const overrides = parsed.map((raw, index): RepresentativeQueryOverrideConfig => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${sourceLabel}[${index}] must be an object`);
    }
    const row = raw as Record<string, unknown>;
    const allowed = new Set(['clusterId', 'keywordIds', 'reason']);
    const unknown = Object.keys(row).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new Error(`${sourceLabel}[${index}] has unknown field(s): ${unknown.join(', ')}`);
    }
    if (typeof row.clusterId !== 'string') {
      throw new Error(`${sourceLabel}[${index}].clusterId must be a string`);
    }
    if (!Array.isArray(row.keywordIds) || row.keywordIds.some((id) => !Number.isInteger(id))) {
      throw new Error(`${sourceLabel}[${index}].keywordIds must be an integer array`);
    }
    if (typeof row.reason !== 'string') {
      throw new Error(`${sourceLabel}[${index}].reason must be a string`);
    }
    return {
      clusterId: row.clusterId,
      keywordIds: row.keywordIds as number[],
      reason: row.reason,
    };
  });

  validateRepresentativeQueriesConfig({
    ...defaultRepresentativeQueriesConfig(),
    overrides,
  });
  return overrides;
}

export function resolveRepresentativeQueriesConfig(input: {
  existing?: RepresentativeQueryRunConfigSnapshot | null | undefined;
  targetCount?: number | undefined;
  overrides?: RepresentativeQueryOverrideConfig[] | undefined;
  selectedClusterIds?: string[] | undefined;
}): RepresentativeQueryRunConfigSnapshot {
  const base = input.existing ?? {
    ...defaultRepresentativeQueriesConfig(),
    selectedClusterIds: [],
  };
  const selectedClusterIds = input.selectedClusterIds ?? base.selectedClusterIds;
  validateSelectedClusterIds(selectedClusterIds);

  const resolved: RepresentativeQueryRunConfigSnapshot = {
    targetCount: input.targetCount ?? base.targetCount,
    overrides: input.overrides ?? base.overrides,
    setVersion: REPRESENTATIVE_QUERY_SET_VERSION,
    selectedClusterIds: [...selectedClusterIds].sort(compareClusterIds),
  };
  validateRepresentativeQueriesConfig(resolved);
  return resolved;
}

export function validateSelectedClusterIds(clusterIds: string[]): void {
  if (clusterIds.length === 0) {
    throw new Error('Representative queries require at least one explicitly selected finalist cluster');
  }
  const seen = new Set<string>();
  for (const clusterId of clusterIds) {
    if (clusterId.trim() === '') throw new Error('Representative finalist cluster id cannot be empty');
    if (seen.has(clusterId)) throw new Error(`Duplicate representative finalist cluster id: ${clusterId}`);
    seen.add(clusterId);
  }
}

function compareClusterIds(a: string, b: string): number {
  const aMatch = /^cluster-(\d+)$/.exec(a);
  const bMatch = /^cluster-(\d+)$/.exec(b);
  if (aMatch && bMatch) {
    const numeric = Number(aMatch[1]) - Number(bMatch[1]);
    if (numeric !== 0) return numeric;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
