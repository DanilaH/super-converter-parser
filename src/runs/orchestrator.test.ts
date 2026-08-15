import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { runKeywordBatch, type CollectKeywordFn } from './orchestrator.js';
import { createRunId, type KeywordRecord, type RunManifest } from './run.js';
import type { CollectionResult } from '../browser/collect.js';

const noopLogger = () => undefined;

function completedRecord(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: {
        volume: 100,
        cpc: 1.5,
        market: 'US',
        fetchedAt: new Date().toISOString(),
      },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://www.google.com/search?q=x',
        detectedLocation: 'United States',
        geoWarning: false,
      },
      error: null,
    },
    serpRows: [],
    debugArtifactPath: null,
  };
}

function failedRecord(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'failed',
      surfer: null,
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://www.google.com/search?q=x',
        detectedLocation: null,
        geoWarning: false,
      },
      error: { code: 'SURFER_NOT_DETECTED', message: 'widget missing' },
    },
    serpRows: [],
    debugArtifactPath: null,
  };
}

function partialRecord(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'partial',
      surfer: {
        volume: 50,
        cpc: null,
        market: 'US',
        fetchedAt: new Date().toISOString(),
      },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://www.google.com/search?q=x',
        detectedLocation: null,
        geoWarning: false,
      },
      error: { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'empty SERP' },
    },
    serpRows: [],
    debugArtifactPath: null,
  };
}

async function readManifest(directory: string): Promise<RunManifest> {
  return JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as RunManifest;
}

test('orchestration: two inputs produce exactly two keywords.json records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orr-happy-'));
  const keywords = buildSeedKeywords([
    { keyword: 'alpha', rowNumber: 1 },
    { keyword: 'beta', rowNumber: 2 },
  ]);
  const config = loadConfig({});

  const collect: CollectKeywordFn = async (keyword) => completedRecord(keyword);
  const result = await runKeywordBatch(
    createRunId(),
    config,
    keywords,
    { kind: 'seeds', path: 'fixtures/seeds.csv' },
    directory,
    `${directory}/debug`,
    collect,
    noopLogger,
  );

  const written = JSON.parse(await readFile(join(directory, 'keywords.json'), 'utf8')) as KeywordRecord[];
  assert.equal(written.length, 2);
  assert.equal(result.records.length, 2);

  for (const record of written) {
    assert.notEqual(record.status, 'pending');
    assert.notEqual(record.status, 'running');
    assert.equal(record.status, 'completed');
  }

  const finalManifest = await readManifest(directory);
  assert.equal(finalManifest.progress.totalKeywords, 2);
  assert.equal(finalManifest.progress.completedKeywords, 2);
  assert.equal(finalManifest.progress.errors, 0);
  assert.equal(finalManifest.state, 'completed');
  assert.ok(finalManifest.progress.completedKeywords <= finalManifest.progress.totalKeywords);
});

test('orchestration: failed and partial are counted as errors and progress never exceeds total', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orr-errors-'));
  const keywords = buildSeedKeywords([
    { keyword: 'alpha', rowNumber: 1 },
    { keyword: 'beta', rowNumber: 2 },
  ]);
  const config = loadConfig({});

  let callCount = 0;
  const collect: CollectKeywordFn = async (keyword) => {
    callCount += 1;
    if (callCount === 2) {
      const intermediate = await readManifest(directory);
      assert.ok(intermediate.progress.completedKeywords <= intermediate.progress.totalKeywords);
      assert.ok(intermediate.progress.errors <= intermediate.progress.totalKeywords);
    }
    return callCount === 1 ? failedRecord(keyword) : partialRecord(keyword);
  };

  const result = await runKeywordBatch(
    createRunId(),
    config,
    keywords,
    { kind: 'seeds', path: 'fixtures/seeds.csv' },
    directory,
    `${directory}/debug`,
    collect,
    noopLogger,
  );

  const written = JSON.parse(await readFile(join(directory, 'keywords.json'), 'utf8')) as KeywordRecord[];
  assert.equal(written.length, 2);
  const statuses = written.map((record) => record.status);
  assert.ok(!statuses.includes('pending'));
  assert.ok(!statuses.includes('running'));

  const finalManifest = await readManifest(directory);
  assert.equal(finalManifest.progress.totalKeywords, 2);
  assert.equal(finalManifest.progress.errors, 2);
  assert.equal(finalManifest.progress.completedKeywords, 1);
  assert.equal(finalManifest.state, 'completed_with_errors');
  assert.ok(finalManifest.progress.completedKeywords <= finalManifest.progress.totalKeywords);
  assert.ok(finalManifest.progress.errors <= finalManifest.progress.totalKeywords);

  assert.equal(result.records[0]!.status, 'failed');
  assert.equal(result.records[1]!.status, 'partial');
});