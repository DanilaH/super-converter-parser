import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { Browser } from 'playwright-core';
import type { CollectionResult } from '../browser/collect.js';
import { RunStore } from '../db/store.js';
import { loadKeywordRetryAttempts } from '../db/retryAttempts.js';
import type { KeywordRecord } from '../runs/run.js';
import { EXIT_INVALID_INPUT, EXIT_OK, type CliDeps } from './research.js';
import { runCliInTestLayout as runCli } from './testCli.js';

function serpRow(record: KeywordRecord, domain: string) {
  return {
    keyword: record.keyword,
    position: 1,
    title: `${domain} title`,
    url: `https://${domain}/tool`,
    hostname: domain,
    registrableDomain: domain,
    dr: null,
    drStatus: null,
    drError: null,
    resultType: 'organic' as const,
  };
}

function completedResult(record: KeywordRecord, domain: string): CollectionResult {
  return {
    record: {
      ...record,
      status: 'completed',
      surfer: {
        volume: 100,
        cpc: 1.5,
        market: 'US',
        fetchedAt: '2026-08-29T00:00:00.000Z',
      },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=x',
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'ok',
        serpError: null,
      },
      error: null,
    },
    serpRows: [serpRow(record, domain)],
    debugArtifactPath: null,
    // A primary repair must not replace an earlier successful related
    // observation with this later empty/error outcome.
    related: { status: 'empty', error: null, rows: [] },
  };
}

function failedResult(record: KeywordRecord): CollectionResult {
  const error = { code: 'GOOGLE_UNAVAILABLE' as const, message: 'transient Google failure' };
  return {
    record: {
      ...record,
      status: 'failed',
      surfer: null,
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=x',
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'fetch_error',
        serpError: error,
      },
      error,
    },
    // Preserve a stale partial row to prove repair republishes/replaces rather
    // than appending duplicate SERP evidence.
    serpRows: [serpRow(record, 'stale.example')],
    debugArtifactPath: null,
    // Related collection is an independent successful fact even though the
    // primary keyword checkpoint failed.
    related: {
      status: 'ok',
      error: null,
      rows: [{
        keyword: 'old related idea',
        normalizedKeyword: 'old related idea',
        overlap: 77,
        volume: 40,
      }],
    },
  };
}

test('--retry-failed requires --resume', async () => {
  const code = await runCli(['--seeds', 'does-not-matter.csv', '--retry-failed']);
  assert.equal(code, EXIT_INVALID_INPUT);
});

test('repair retries only failed keyword, bypasses stale failed cache, and preserves attempt history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-retry-failed-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nhealthy keyword\nfailed keyword', 'utf8');

  let repairPhase = false;
  let connectCalls = 0;
  const collected: string[] = [];
  const deps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return {
        contexts: () => [{}],
        close: async () => undefined,
      } as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, _config, record) => {
      collected.push(`${repairPhase ? 'repair' : 'initial'}:${record.normalizedKeyword}`);
      if (record.normalizedKeyword === 'healthy keyword') {
        return completedResult(record, 'healthy.example');
      }
      return repairPhase
        ? completedResult(record, 'fresh.example')
        : failedResult(record);
    },
  };

  const env = {
    CACHE_DB_PATH: join(directory, 'cache.sqlite'),
    RETRY_MAX_ATTEMPTS: '1',
    RETRY_BASE_DELAY_MS: '0',
    RETRY_MAX_DELAY_MS: '0',
  } as NodeJS.ProcessEnv;
  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = await runCli(['--seeds', 'input/seeds.csv'], deps, env);
    assert.equal(first, EXIT_OK);

    const runsDir = join(directory, 'runs');
    const runId = (await readdir(runsDir))[0] as string;
    const firstStore = RunStore.open(join(runsDir, runId, 'run.sqlite'));
    assert.equal(firstStore.loadRun(runId)?.state, 'completed_with_errors');
    assert.deepEqual(firstStore.loadKeywords(runId).map((keyword) => keyword.status), ['completed', 'failed']);
    assert.deepEqual(
      firstStore.loadSerpRows(runId).map((row) => row.registrableDomain).sort(),
      ['healthy.example', 'stale.example'],
    );
    assert.deepEqual(
      firstStore.loadRelatedKeywords(runId)
        .filter((row) => row.parentIdx === 1)
        .map((row) => [row.status, row.relatedKeyword]),
      [['ok', 'old related idea']],
    );
    firstStore.close();

    const initialCalls = [...collected];
    repairPhase = true;
    const repaired = await runCli(['--resume', runId, '--retry-failed'], deps, env);
    assert.equal(repaired, EXIT_OK);
    assert.equal(connectCalls, 2, 'repair must require browser work instead of serving stale failed cache');

    const repairCalls = collected.slice(initialCalls.length);
    assert.deepEqual(repairCalls, ['repair:failed keyword']);
    assert.equal(
      repairCalls.some((entry) => entry.includes('healthy keyword')),
      false,
      'previously completed keyword must stay untouched',
    );

    const finalStore = RunStore.open(join(runsDir, runId, 'run.sqlite'));
    assert.equal(finalStore.loadRun(runId)?.state, 'completed');
    assert.deepEqual(finalStore.loadKeywords(runId).map((keyword) => keyword.status), ['completed', 'completed']);
    assert.equal(finalStore.loadKeyword(runId, 0)?.cacheStatus, 'miss');
    assert.equal(finalStore.loadKeyword(runId, 1)?.cacheStatus, 'refreshed');
    assert.deepEqual(
      finalStore.loadSerpRows(runId).map((row) => row.registrableDomain).sort(),
      ['fresh.example', 'healthy.example'],
      'old failed SERP row must be replaced, not appended',
    );
    assert.deepEqual(
      finalStore.loadRelatedKeywords(runId)
        .filter((row) => row.parentIdx === 1)
        .map((row) => [row.status, row.relatedKeyword]),
      [['ok', 'old related idea']],
      'successful independent related evidence must survive primary repair',
    );

    const attempts = loadKeywordRetryAttempts(finalStore, runId);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.previousRecord.status, 'failed');
    assert.equal(attempts[0]?.previousRecord.error?.message, 'transient Google failure');
    assert.deepEqual(attempts[0]?.previousSerpRows.map((row) => row.registrableDomain), ['stale.example']);
    assert.equal(attempts[0]?.resultRecord?.status, 'completed');
    assert.equal(attempts[0]?.resultRecord?.cacheStatus, 'refreshed');
    assert.deepEqual(attempts[0]?.resultSerpRows?.map((row) => row.registrableDomain), ['fresh.example']);
    finalStore.close();
  } finally {
    process.chdir(previousCwd);
  }
});
