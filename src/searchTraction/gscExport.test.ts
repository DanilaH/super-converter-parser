import assert from 'node:assert/strict';
import test from 'node:test';
import { buildZip } from '../library/zip.js';
import { ResearchError } from '../shared/errors.js';
import { parseGscSearchTractionExport } from './gscExport.js';
import { readFlatZipEntries } from './gscZip.js';

function csv(value: string): Buffer {
  return Buffer.from(value.replace(/^\n/, ''), 'utf8');
}

function gscFixture(): Buffer {
  return buildZip([
    { name: 'Chart.csv', data: csv(`
Date,Clicks,Impressions,CTR,Position
2026-09-01,0,0,,
2026-09-02,1,10,10%,42.5
`) },
    { name: 'Queries.csv', data: csv(`
Top queries,Clicks,Impressions,CTR,Position
keyboard tester,1,4,25%,40
keyboard test,0,2,0%,55
`) },
    { name: 'Pages.csv', data: csv(`
Top pages,Clicks,Impressions,CTR,Position
https://example.com/keyboard-tester,1,10,10%,42.5
`) },
    { name: 'Countries.csv', data: csv(`
Country,Clicks,Impressions,CTR,Position
United States,1,7,14.29%,40
India,0,3,0%,48.33
`) },
    { name: 'Devices.csv', data: csv(`
Device,Clicks,Impressions,CTR,Position
Desktop,1,9,11.11%,42
Mobile,0,1,0%,47
`) },
    { name: 'Search appearance.csv', data: csv(`
Search Appearance,Clicks,Impressions,CTR,Position
`) },
    { name: 'Filters.csv', data: csv(`
Filter,Value
Search type,Web
Date,Last 3 months
`) },
  ], new Date('2026-09-06T00:00:00Z'));
}

test('GSC export keeps filters, observed chart range, and independent dimension coverage explicit', () => {
  const snapshot = parseGscSearchTractionExport({
    archive: gscFixture(),
    property: 'sc-domain:example.com',
  });

  assert.equal(snapshot.property, 'sc-domain:example.com');
  assert.deepEqual(snapshot.filters, [
    { name: 'Search type', value: 'Web' },
    { name: 'Date', value: 'Last 3 months' },
  ]);
  assert.deepEqual(snapshot.observedRange, {
    startDate: '2026-09-01',
    endDate: '2026-09-02',
  });
  assert.deepEqual(snapshot.totals, { clicks: 1, impressions: 10 });
  assert.equal(snapshot.chart[0]?.ctrRatio, null);
  assert.equal(snapshot.chart[0]?.position, null);
  assert.equal(snapshot.dimensions.search_appearance.length, 0, 'header-only Search Appearance must be preserved as an empty aggregate, not an error');
  assert.equal(snapshot.coverage.query.impressions, 6);
  assert.equal(snapshot.coverage.query.impressionCoverageRatio, 0.6, 'query rows can cover less than chart totals and must not be padded/fabricated');
  assert.equal(snapshot.coverage.page.impressionCoverageRatio, 1);
  assert.equal(snapshot.dimensions.query[0]?.value, 'keyboard tester');
  assert.equal(snapshot.dimensions.page[0]?.value, 'https://example.com/keyboard-tester');
});

test('GSC export requires explicit property identity', () => {
  assert.throws(
    () => parseGscSearchTractionExport({ archive: gscFixture(), property: '  ' }),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /--property/.test(error.message),
  );
});

test('GSC export fails closed when a required aggregate file is missing', () => {
  const archive = buildZip([
    { name: 'Chart.csv', data: csv('Date,Clicks,Impressions,CTR,Position\n') },
  ]);
  assert.throws(
    () => parseGscSearchTractionExport({ archive, property: 'sc-domain:example.com' }),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /Queries\.csv/.test(error.message),
  );
});

test('bounded ZIP reader rejects nested entries rather than extracting paths', () => {
  const archive = buildZip([{ name: '../Chart.csv', data: csv('x\n') }]);
  assert.throws(
    () => readFlatZipEntries(archive),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /Unsafe or nested/.test(error.message),
  );
});
