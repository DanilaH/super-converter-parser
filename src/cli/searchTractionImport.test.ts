import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import type { ImportGscSearchTractionResult } from '../searchTraction/import.js';
import { parseSearchTractionImportArgs, renderSearchTractionImport } from './searchTractionImport.js';

test('search-traction:import requires explicit input and property', () => {
  assert.throws(
    () => parseSearchTractionImportArgs(['--input', 'export.zip']),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /--property/.test(error.message),
  );
});

test('search-traction:import parses explicit source identity and output options', () => {
  assert.deepEqual(
    parseSearchTractionImportArgs([
      '--input',
      'gsc.zip',
      '--property',
      'sc-domain:example.com',
      '--output-root',
      '/tmp/research',
      '--json',
    ]),
    {
      help: false,
      inputPath: 'gsc.zip',
      property: 'sc-domain:example.com',
      outputRoot: '/tmp/research',
      json: true,
    },
  );
});

test('search-traction import text distinguishes export filters, observed range, duplicate state, and neutral ratios', () => {
  const result: ImportGscSearchTractionResult = {
    snapshotId: 'gsc_fixture',
    changed: false,
    sourceArchiveRestored: false,
    databasePath: '/tmp/search-traction.sqlite',
    sourceArchivePath: '/tmp/gsc_fixture.zip',
    snapshotCount: 1,
    inputPath: '/tmp/export.zip',
    property: 'sc-domain:example.com',
    sourceSha256: 'abc',
    filters: [
      { name: 'Search type', value: 'Web' },
      { name: 'Date', value: 'Last 3 months' },
    ],
    observedRange: { startDate: '2026-09-01', endDate: '2026-09-04' },
    totals: { clicks: 1, impressions: 10 },
    dimensionTotals: {
      query: { clicks: 1, impressions: 6, clickRatioToChart: 1, impressionRatioToChart: 0.6 },
      page: { clicks: 1, impressions: 11, clickRatioToChart: 1, impressionRatioToChart: 1.1 },
      country: { clicks: 1, impressions: 10, clickRatioToChart: 1, impressionRatioToChart: 1 },
      device: { clicks: 1, impressions: 10, clickRatioToChart: 1, impressionRatioToChart: 1 },
      search_appearance: { clicks: 0, impressions: 0, clickRatioToChart: 0, impressionRatioToChart: 0 },
    },
    rowCounts: {
      chart: 4,
      queries: 2,
      pages: 1,
      countries: 2,
      devices: 2,
      searchAppearance: 0,
    },
  };

  const text = renderSearchTractionImport(result);
  assert.match(text, /Observed chart range: 2026-09-01\.\.2026-09-04/);
  assert.match(text, /Date=Last 3 months/);
  assert.match(text, /queries=60\.0% pages=110\.0%/);
  assert.match(text, /duplicate source\/parser snapshot/);
});
