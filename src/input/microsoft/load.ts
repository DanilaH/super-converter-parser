import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { ResearchError } from '../../shared/errors.js';
import type { MicrosoftRow } from './normalize.js';

// Microsoft Keyword Planner export column names vary (locale, account settings,
// and UI changes). We detect by a normalized exact match against a set of known
// aliases rather than assuming one fixed header order or spelling.
const HEADER_ALIASES = {
  keyword: ['keyword'],
  adGroup: ['ad group', 'adgroup', 'campaign', 'ad group name'],
  volume: [
    'average monthly searches',
    'avg monthly searches',
    'avg. monthly searches',
    'monthly searches',
    'search volume',
    'volume',
  ],
  competition: ['competition', 'competition level'],
  cpc: ['suggested bid', 'suggested bid (cpc)', 'avg cpc', 'cpc', 'bid'],
} as const;

type ColumnMap = {
  keyword: string;
  adGroup?: string | undefined;
  volume?: string | undefined;
  competition?: string | undefined;
  cpc?: string | undefined;
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function detectColumns(headers: string[]): ColumnMap {
  const normalized = headers.map(normalizeHeader);
  const find = (aliases: readonly string[]): string | undefined => {
    const index = normalized.findIndex((header) => (aliases as readonly string[]).includes(header));
    return index >= 0 ? headers[index] : undefined;
  };

  const keyword = find(HEADER_ALIASES.keyword);
  if (!keyword) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Microsoft file must have a "Keyword" column. Found: ${headers
        .map((header) => `"${header}"`)
        .join(', ')}.`,
    );
  }

  return {
    keyword,
    adGroup: find(HEADER_ALIASES.adGroup),
    volume: find(HEADER_ALIASES.volume),
    competition: find(HEADER_ALIASES.competition),
    cpc: find(HEADER_ALIASES.cpc),
  };
}

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '-') return null;
  return trimmed;
}

// A non-empty, non-numeric value is a schema error (with the offending row and
// column), not a silent null. Only an empty/`null` cell becomes null.
function parseNumberOrThrow(value: string | null, rowNumber: number, column: string): number | null {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Microsoft file "${column}" at row ${rowNumber} is not a valid number: "${value}".`,
    );
  }
  return number;
}

export async function loadMicrosoftRows(path: string): Promise<MicrosoftRow[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Cannot read Microsoft file "${path}".`, { cause: error });
  }

  if (content.trim() === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Microsoft file "${path}" is empty.`);
  }

  let records: Array<Record<string, string>>;
  try {
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: false,
    }) as Array<Record<string, string>>;
  } catch (error) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Microsoft file "${path}" is not valid CSV.`,
      { cause: error },
    );
  }

  if (records.length === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Microsoft file "${path}" has no data rows.`);
  }

  const columns = detectColumns(Object.keys(records[0]!));

  const rows: MicrosoftRow[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    const rowNumber = index + 2;
    const keyword = String(record[columns.keyword] ?? '').trim();

    if (!keyword) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Microsoft file "${path}" row ${rowNumber} has an empty "Keyword" value.`,
      );
    }

    const volumeBucket = emptyToNull(columns.volume ? record[columns.volume] : undefined);
    const competition = emptyToNull(columns.competition ? record[columns.competition] : undefined);
    const cpc = parseNumberOrThrow(
      emptyToNull(columns.cpc ? record[columns.cpc] : undefined),
      rowNumber,
      columns.cpc ?? 'cpc',
    );

    rows.push({
      adGroup: columns.adGroup ? (emptyToNull(record[columns.adGroup]) ?? '') : '',
      keyword,
      volumeBucket,
      competition,
      cpc,
      rowNumber,
    });
  }

  return rows;
}
