import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { ResearchError } from '../shared/errors.js';
import { readFlatZipEntries } from './gscZip.js';

export const GSC_EXPORT_PARSER_VERSION = '1.0.0' as const;
export const GSC_EXPORT_SOURCE_KIND = 'google_search_console_ui_export' as const;

const REQUIRED_FILES = [
  'Chart.csv',
  'Queries.csv',
  'Pages.csv',
  'Countries.csv',
  'Devices.csv',
  'Search appearance.csv',
  'Filters.csv',
] as const;

export type SearchMetricRow = {
  clicks: number;
  impressions: number;
  ctrRatio: number | null;
  position: number | null;
};

export type SearchTractionDailyRow = SearchMetricRow & {
  date: string;
};

export type SearchTractionDimension = 'query' | 'page' | 'country' | 'device' | 'search_appearance';

export type SearchTractionDimensionRow = SearchMetricRow & {
  value: string;
};

export type SearchTractionFilter = {
  name: string;
  value: string;
};

export type SearchTractionCoverage = {
  clicks: number;
  impressions: number;
  clickCoverageRatio: number | null;
  impressionCoverageRatio: number | null;
};

export type GscSearchTractionSnapshot = {
  version: 1;
  property: string;
  source: {
    kind: typeof GSC_EXPORT_SOURCE_KIND;
    parserVersion: typeof GSC_EXPORT_PARSER_VERSION;
    sha256: string;
  };
  filters: SearchTractionFilter[];
  observedRange: {
    startDate: string;
    endDate: string;
  } | null;
  totals: {
    clicks: number;
    impressions: number;
  };
  chart: SearchTractionDailyRow[];
  dimensions: Record<SearchTractionDimension, SearchTractionDimensionRow[]>;
  coverage: Record<SearchTractionDimension, SearchTractionCoverage>;
};

type CsvRecord = Record<string, string>;

export function parseGscSearchTractionExport(input: {
  archive: Buffer;
  property: string;
}): GscSearchTractionSnapshot {
  const property = input.property.trim();
  if (property === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--property must be a non-empty explicit Search Console property identifier.');
  }

  const entries = readFlatZipEntries(input.archive);
  for (const name of REQUIRED_FILES) {
    if (!entries.has(name)) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `GSC export is missing required file ${name}.`);
    }
  }

  const chart = parseChart(requiredEntry(entries, 'Chart.csv'));
  const dimensions: Record<SearchTractionDimension, SearchTractionDimensionRow[]> = {
    query: parseDimension(requiredEntry(entries, 'Queries.csv'), 'Queries.csv', 'Top queries'),
    page: parseDimension(requiredEntry(entries, 'Pages.csv'), 'Pages.csv', 'Top pages'),
    country: parseDimension(requiredEntry(entries, 'Countries.csv'), 'Countries.csv', 'Country'),
    device: parseDimension(requiredEntry(entries, 'Devices.csv'), 'Devices.csv', 'Device'),
    search_appearance: parseDimension(requiredEntry(entries, 'Search appearance.csv'), 'Search appearance.csv', 'Search Appearance'),
  };
  const filters = parseFilters(requiredEntry(entries, 'Filters.csv'));
  const totals = chart.reduce(
    (acc, row) => ({ clicks: acc.clicks + row.clicks, impressions: acc.impressions + row.impressions }),
    { clicks: 0, impressions: 0 },
  );
  const dates = chart.map((row) => row.date).sort();
  const coverage = Object.fromEntries(
    (Object.keys(dimensions) as SearchTractionDimension[]).map((dimension) => [
      dimension,
      coverageFor(dimensions[dimension], totals),
    ]),
  ) as Record<SearchTractionDimension, SearchTractionCoverage>;

  return {
    version: 1,
    property,
    source: {
      kind: GSC_EXPORT_SOURCE_KIND,
      parserVersion: GSC_EXPORT_PARSER_VERSION,
      sha256: createHash('sha256').update(input.archive).digest('hex'),
    },
    filters,
    observedRange: dates.length === 0
      ? null
      : { startDate: dates[0]!, endDate: dates.at(-1)! },
    totals,
    chart,
    dimensions,
    coverage,
  };
}

function parseChart(data: Buffer): SearchTractionDailyRow[] {
  const records = parseCsv(data, 'Chart.csv', ['Date', 'Clicks', 'Impressions', 'CTR', 'Position']);
  const seen = new Set<string>();
  return records.map((record, index) => {
    const date = requiredCell(record, 'Date', 'Chart.csv', index);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw rowError('Chart.csv', index, `invalid Date ${JSON.stringify(date)}`);
    }
    if (seen.has(date)) throw rowError('Chart.csv', index, `duplicate Date ${date}`);
    seen.add(date);
    return {
      date,
      ...parseMetrics(record, 'Chart.csv', index),
    };
  });
}

function parseDimension(
  data: Buffer,
  fileName: string,
  valueColumn: string,
): SearchTractionDimensionRow[] {
  const records = parseCsv(data, fileName, [valueColumn, 'Clicks', 'Impressions', 'CTR', 'Position']);
  return records.map((record, index) => ({
    value: requiredCell(record, valueColumn, fileName, index),
    ...parseMetrics(record, fileName, index),
  }));
}

function parseFilters(data: Buffer): SearchTractionFilter[] {
  const records = parseCsv(data, 'Filters.csv', ['Filter', 'Value']);
  return records.map((record, index) => ({
    name: requiredCell(record, 'Filter', 'Filters.csv', index),
    value: cell(record, 'Value'),
  }));
}

function parseCsv(data: Buffer, fileName: string, requiredColumns: string[]): CsvRecord[] {
  let records: CsvRecord[];
  try {
    records = parse(data.toString('utf8'), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: false,
    }) as CsvRecord[];
  } catch (error) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Cannot parse ${fileName} from GSC export.`, { cause: error });
  }

  if (records.length === 0) {
    const header = firstCsvHeader(data);
    for (const column of requiredColumns) {
      if (!header.includes(column)) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', `${fileName} is missing required column ${JSON.stringify(column)}.`);
      }
    }
    return [];
  }

  const columns = Object.keys(records[0]!);
  for (const column of requiredColumns) {
    if (!columns.includes(column)) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `${fileName} is missing required column ${JSON.stringify(column)}.`);
    }
  }
  return records;
}

function firstCsvHeader(data: Buffer): string[] {
  try {
    const rows = parse(data.toString('utf8'), { bom: true, to_line: 1 }) as string[][];
    return rows[0] ?? [];
  } catch (error) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Cannot parse GSC CSV header.', { cause: error });
  }
}

function parseMetrics(record: CsvRecord, fileName: string, index: number): SearchMetricRow {
  const clicks = parseNonNegativeInteger(requiredCell(record, 'Clicks', fileName, index), fileName, index, 'Clicks');
  const impressions = parseNonNegativeInteger(requiredCell(record, 'Impressions', fileName, index), fileName, index, 'Impressions');
  const ctrRatio = parseCtr(cell(record, 'CTR'), fileName, index);
  const position = parseOptionalNonNegativeNumber(cell(record, 'Position'), fileName, index, 'Position');

  if (ctrRatio !== null && (ctrRatio < 0 || ctrRatio > 1)) {
    throw rowError(fileName, index, `CTR must be between 0% and 100%, got ${record.CTR}`);
  }
  return { clicks, impressions, ctrRatio, position };
}

function parseCtr(value: string, fileName: string, index: number): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!trimmed.endsWith('%')) throw rowError(fileName, index, `CTR must use percent notation, got ${JSON.stringify(value)}`);
  const numeric = Number(trimmed.slice(0, -1));
  if (!Number.isFinite(numeric)) throw rowError(fileName, index, `invalid CTR ${JSON.stringify(value)}`);
  return numeric / 100;
}

function parseNonNegativeInteger(value: string, fileName: string, index: number, field: string): number {
  const numeric = Number(value.trim());
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw rowError(fileName, index, `${field} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return numeric;
}

function parseOptionalNonNegativeNumber(
  value: string,
  fileName: string,
  index: number,
  field: string,
): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw rowError(fileName, index, `${field} must be a non-negative number, got ${JSON.stringify(value)}`);
  }
  return numeric;
}

function coverageFor(
  rows: SearchTractionDimensionRow[],
  totals: { clicks: number; impressions: number },
): SearchTractionCoverage {
  const sums = rows.reduce(
    (acc, row) => ({ clicks: acc.clicks + row.clicks, impressions: acc.impressions + row.impressions }),
    { clicks: 0, impressions: 0 },
  );
  return {
    ...sums,
    clickCoverageRatio: totals.clicks === 0 ? null : sums.clicks / totals.clicks,
    impressionCoverageRatio: totals.impressions === 0 ? null : sums.impressions / totals.impressions,
  };
}

function requiredEntry(entries: Map<string, Buffer>, name: string): Buffer {
  const value = entries.get(name);
  if (!value) throw new ResearchError('INPUT_SCHEMA_ERROR', `GSC export is missing required file ${name}.`);
  return value;
}

function requiredCell(record: CsvRecord, column: string, fileName: string, index: number): string {
  const value = cell(record, column).trim();
  if (value === '') throw rowError(fileName, index, `${column} must not be blank`);
  return value;
}

function cell(record: CsvRecord, column: string): string {
  return String(record[column] ?? '');
}

function rowError(fileName: string, index: number, message: string): ResearchError {
  return new ResearchError('INPUT_SCHEMA_ERROR', `${fileName} row ${index + 2}: ${message}.`);
}
