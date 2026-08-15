import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { ResearchError } from '../../shared/errors.js';
import type { SeedRow } from './normalize.js';

export async function loadSeedRows(path: string): Promise<SeedRow[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Cannot read seeds file "${path}".`,
      { cause: error },
    );
  }

  if (content.trim() === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Seeds file "${path}" is empty.`);
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
      `Seeds file "${path}" is not valid CSV.`,
      { cause: error },
    );
  }

  const firstRecord = records[0];
  if (!firstRecord) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Seeds file "${path}" has no data rows.`);
  }

  const keywordColumn = Object.keys(firstRecord).find(
    (column) => column.trim().toLowerCase() === 'keyword',
  );

  if (!keywordColumn) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Seeds file "${path}" must have a "keyword" column. Found: ${Object.keys(firstRecord)
        .map((column) => `"${column}"`)
        .join(', ')}.`,
    );
  }

  const rows: SeedRow[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    const rowNumber = index + 2;
    const keyword = String(record[keywordColumn] ?? '').trim();

    if (!keyword) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Seeds file "${path}" row ${rowNumber} has an empty "keyword" value.`,
      );
    }

    rows.push({ keyword, rowNumber });
  }

  return rows;
}