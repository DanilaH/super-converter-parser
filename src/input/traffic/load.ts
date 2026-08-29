import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import type { TrafficEntityScope, TrafficSnapshotInput } from '../../enrichment/trafficEvidence.js';
import { ResearchError } from '../../shared/errors.js';

const REQUIRED_COLUMNS = [
  'target_cluster_id',
  'scope',
  'entity',
  'observed_at',
  'provider_data_date',
  'market',
  'source',
  'organic_traffic',
  'traffic_value',
  'traffic_value_currency',
  'provenance',
] as const;

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requiredText(
  record: Record<string, string>,
  column: string,
  rowNumber: number,
  path: string,
): string {
  const value = emptyToNull(record[column]);
  if (value === null) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Traffic file "${path}" row ${rowNumber} has an empty "${column}" value.`,
    );
  }
  return value;
}

function parseScope(value: string, rowNumber: number, path: string): TrafficEntityScope {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'domain' || normalized === 'url') return normalized;
  throw new ResearchError(
    'INPUT_SCHEMA_ERROR',
    `Traffic file "${path}" row ${rowNumber} has invalid scope "${value}"; expected domain or url.`,
  );
}

function parseMetric(
  value: string | undefined,
  column: string,
  rowNumber: number,
  path: string,
): number | null {
  const raw = emptyToNull(value);
  if (raw === null) return null;
  const normalized = /^\d{1,3}(,\d{3})+(?:\.\d+)?$/.test(raw)
    ? raw.replaceAll(',', '')
    : raw;
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Traffic file "${path}" row ${rowNumber} "${column}" must be a non-negative number or blank; got "${raw}".`,
    );
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Traffic file "${path}" row ${rowNumber} "${column}" is outside the supported numeric range.`,
    );
  }
  return parsed;
}

function normalizeHeaders(headers: string[], path: string): string[] {
  const normalized = headers.map((header) => header.trim().toLowerCase());
  const duplicates = normalized.filter((header, index, all) => all.indexOf(header) !== index);
  if (duplicates.length > 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Traffic file "${path}" has duplicate column(s): ${[...new Set(duplicates)].join(', ')}.`,
    );
  }
  const available = new Set(normalized);
  const missing = REQUIRED_COLUMNS.filter((column) => !available.has(column));
  if (missing.length > 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Traffic file "${path}" is missing required column(s): ${missing.join(', ')}.`,
    );
  }
  return normalized;
}

export async function loadTrafficSnapshotRows(path: string): Promise<TrafficSnapshotInput[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Cannot read traffic file "${path}".`, { cause: error });
  }
  if (content.trim() === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Traffic file "${path}" is empty.`);
  }

  let records: Array<Record<string, string>>;
  try {
    records = parse(content, {
      columns: (headers: string[]) => normalizeHeaders(headers, path),
      skip_empty_lines: true,
      bom: true,
      trim: false,
    }) as Array<Record<string, string>>;
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Traffic file "${path}" is not valid CSV.`,
      { cause: error },
    );
  }
  if (records.length === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Traffic file "${path}" has no data rows.`);
  }

  return records.map((record, index) => {
    const rowNumber = index + 2;
    return {
      targetClusterId: requiredText(record, 'target_cluster_id', rowNumber, path),
      scope: parseScope(requiredText(record, 'scope', rowNumber, path), rowNumber, path),
      entity: requiredText(record, 'entity', rowNumber, path),
      observedAt: requiredText(record, 'observed_at', rowNumber, path),
      providerDataDate: requiredText(record, 'provider_data_date', rowNumber, path),
      market: requiredText(record, 'market', rowNumber, path),
      source: requiredText(record, 'source', rowNumber, path),
      organicTraffic: parseMetric(record.organic_traffic, 'organic_traffic', rowNumber, path),
      trafficValue: parseMetric(record.traffic_value, 'traffic_value', rowNumber, path),
      trafficValueCurrency: emptyToNull(record.traffic_value_currency),
      provenance: requiredText(record, 'provenance', rowNumber, path),
    };
  });
}
