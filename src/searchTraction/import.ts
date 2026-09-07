import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ResearchError } from '../shared/errors.js';
import { parseGscSearchTractionExport, type GscSearchTractionSnapshot } from './gscExport.js';
import { persistGscSearchTractionSnapshot, type PersistSearchTractionResult } from './store.js';

export type ImportGscSearchTractionResult = PersistSearchTractionResult & {
  inputPath: string;
  property: string;
  sourceSha256: string;
  filters: GscSearchTractionSnapshot['filters'];
  observedRange: GscSearchTractionSnapshot['observedRange'];
  totals: GscSearchTractionSnapshot['totals'];
  coverage: GscSearchTractionSnapshot['coverage'];
  rowCounts: {
    chart: number;
    queries: number;
    pages: number;
    countries: number;
    devices: number;
    searchAppearance: number;
  };
};

export async function importGscSearchTraction(input: {
  outputRoot: string;
  inputPath: string;
  property: string;
  now?: () => Date;
}): Promise<ImportGscSearchTractionResult> {
  const inputPath = resolve(input.inputPath);
  let archive: Buffer;
  try {
    archive = await readFile(inputPath);
  } catch (error) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Cannot read GSC export ZIP ${inputPath}.`, { cause: error });
  }

  const snapshot = parseGscSearchTractionExport({ archive, property: input.property });
  const persisted = await persistGscSearchTractionSnapshot({
    outputRoot: input.outputRoot,
    archive,
    snapshot,
    ...(input.now ? { now: input.now } : {}),
  });

  return {
    ...persisted,
    inputPath,
    property: snapshot.property,
    sourceSha256: snapshot.source.sha256,
    filters: snapshot.filters,
    observedRange: snapshot.observedRange,
    totals: snapshot.totals,
    coverage: snapshot.coverage,
    rowCounts: {
      chart: snapshot.chart.length,
      queries: snapshot.dimensions.query.length,
      pages: snapshot.dimensions.page.length,
      countries: snapshot.dimensions.country.length,
      devices: snapshot.dimensions.device.length,
      searchAppearance: snapshot.dimensions.search_appearance.length,
    },
  };
}
