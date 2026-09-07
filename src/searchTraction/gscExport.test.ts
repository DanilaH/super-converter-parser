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
https://example.com/keyboard-tester,1,11,9.09%,42.5
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

test('GSC export keeps filters, observed chart range, and independent dimension totals explicit', () => {
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
  assert.equal(snapshot.dimensionTotals.query.impressions, 6);
  assert.equal(snapshot.dimensionTotals.query.impressionRatioToChart, 0.6, 'query rows may total less than Chart and must not be padded/fabricated');
  assert.equal(snapshot.dimensionTotals.page.impressions, 11);
  assert.equal(snapshot.dimensionTotals.page.impressionRatioToChart, 1.1, 'dimension/chart ratios may exceed 100% and are not universal coverage fractions');
  assert.equal(snapshot.dimensions.query[0]?.value, 'keyboard tester');
  assert.equal(snapshot.dimensions.page[0]?.value, 'https://example.com/keyboard-tester');
});

test('GSC export preserves dimension label text rather than trimming it silently', () => {
  const archive = buildZip([
    { name: 'Chart.csv', data: csv('Date,Clicks,Impressions,CTR,Position\n2026-09-01,0,1,0%,1\n') },
    { name: 'Queries.csv', data: csv('Top queries,Clicks,Impressions,CTR,Position\n"  spaced query  ",0,1,0%,1\n') },
    { name: 'Pages.csv', data: csv('Top pages,Clicks,Impressions,CTR,Position\nhttps://example.com/,0,1,0%,1\n') },
    { name: 'Countries.csv', data: csv('Country,Clicks,Impressions,CTR,Position\nUS,0,1,0%,1\n') },
    { name: 'Devices.csv', data: csv('Device,Clicks,Impressions,CTR,Position\nDesktop,0,1,0%,1\n') },
    { name: 'Search appearance.csv', data: csv('Search Appearance,Clicks,Impressions,CTR,Position\n') },
    { name: 'Filters.csv', data: csv('Filter,Value\nSearch type,Web\n') },
  ]);
  const snapshot = parseGscSearchTractionExport({ archive, property: 'sc-domain:example.com' });
  assert.equal(snapshot.dimensions.query[0]?.value, '  spaced query  ');
});

test('GSC export rejects calendar-invalid chart dates', () => {
  const archive = buildZip([
    { name: 'Chart.csv', data: csv('Date,Clicks,Impressions,CTR,Position\n2026-02-31,0,1,0%,1\n') },
    { name: 'Queries.csv', data: csv('Top queries,Clicks,Impressions,CTR,Position\nq,0,1,0%,1\n') },
    { name: 'Pages.csv', data: csv('Top pages,Clicks,Impressions,CTR,Position\nhttps://example.com/,0,1,0%,1\n') },
    { name: 'Countries.csv', data: csv('Country,Clicks,Impressions,CTR,Position\nUS,0,1,0%,1\n') },
    { name: 'Devices.csv', data: csv('Device,Clicks,Impressions,CTR,Position\nDesktop,0,1,0%,1\n') },
    { name: 'Search appearance.csv', data: csv('Search Appearance,Clicks,Impressions,CTR,Position\n') },
    { name: 'Filters.csv', data: csv('Filter,Value\nSearch type,Web\n') },
  ]);
  assert.throws(
    () => parseGscSearchTractionExport({ archive, property: 'sc-domain:example.com' }),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /invalid Date/.test(error.message),
  );
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

test('bounded ZIP reader accepts central-directory sizes when Google-style data descriptors are flagged', () => {
  const original = buildZip([{ name: 'Chart.csv', data: csv('Date,Clicks\n2026-09-01,0\n') }]);
  const eocdOffset = original.length - 22;
  const centralOffset = original.readUInt32LE(eocdOffset + 16);
  const expectedCrc = original.readUInt32LE(centralOffset + 16);
  const compressedSize = original.readUInt32LE(centralOffset + 20);
  const uncompressedSize = original.readUInt32LE(centralOffset + 24);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(expectedCrc, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);

  const archive = Buffer.concat([
    original.subarray(0, centralOffset),
    descriptor,
    original.subarray(centralOffset),
  ]);
  archive.writeUInt16LE(original.readUInt16LE(6) | 0x0008, 6);
  archive.writeUInt32LE(0, 14);
  archive.writeUInt32LE(0, 18);
  archive.writeUInt32LE(0, 22);
  const shiftedCentralOffset = centralOffset + descriptor.length;
  archive.writeUInt16LE(original.readUInt16LE(centralOffset + 8) | 0x0008, shiftedCentralOffset + 8);
  const shiftedEocdOffset = eocdOffset + descriptor.length;
  archive.writeUInt32LE(shiftedCentralOffset, shiftedEocdOffset + 16);

  const entries = readFlatZipEntries(archive);
  assert.equal(entries.get('Chart.csv')?.toString('utf8'), 'Date,Clicks\n2026-09-01,0\n');
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
