import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DiscoveryTimingRecorder,
  renderDiscoveryTimingSummary,
  writeDiscoveryTimingArtifact,
} from './timing.js';

const rootSample = {
  kind: 'primary' as const,
  keyword: 'alpha',
  normalizedKeyword: 'alpha',
  isRoot: true,
  outcome: 'completed' as const,
  captchaEncountered: true,
  relatedOutcome: 'ok' as const,
  pageCreateMs: 10,
  navigationMs: 100,
  captchaMs: 20,
  mainSurferMs: 200,
  relatedSurferMs: 300,
  serpParseMs: 30,
  locationParseMs: 40,
  totalMs: 700,
};

test('DiscoveryTimingRecorder aggregates browser, Ahrefs, and engine sleep timings deterministically', () => {
  const recorder = new DiscoveryTimingRecorder(1_000);
  recorder.recordBrowser(rootSample);
  recorder.recordBrowser({
    ...rootSample,
    keyword: 'beta',
    normalizedKeyword: 'beta',
    isRoot: false,
    captchaEncountered: false,
    relatedOutcome: null,
    relatedSurferMs: null,
    totalMs: 500,
  });
  recorder.recordAhrefs('example.com', 250, 'ok');
  recorder.recordSleep(1_000);
  recorder.recordSleep(500);

  const summary = recorder.snapshot({ runId: 'run-1', mode: 'fresh', state: 'completed', finishedAtMs: 3_000 });
  assert.equal(summary.wallMs, 2_000);
  assert.equal(summary.counts.primaryBrowserCollections, 2);
  assert.equal(summary.counts.rootPrimaryCollections, 1);
  assert.equal(summary.counts.expandedPrimaryCollections, 1);
  assert.equal(summary.counts.captchaEncounters, 1);
  assert.equal(summary.counts.relatedOk, 1);
  assert.equal(summary.counts.relatedEmpty, 0);
  assert.equal(summary.counts.relatedError, 0);
  assert.equal(summary.counts.ahrefsClientCalls, 1);
  assert.equal(summary.counts.engineSleepCalls, 2);
  assert.equal(summary.totals.browserCollectionMs, 1_200);
  assert.equal(summary.totals.relatedSurferMs, 300);
  assert.equal(summary.totals.ahrefsClientMs, 250);
  assert.equal(summary.totals.engineSleepRequestedMs, 1_500);
  assert.deepEqual(summary.distributions.primaryBrowserCollectionMs, {
    count: 2,
    minMs: 500,
    p50Ms: 500,
    p95Ms: 700,
    maxMs: 700,
    averageMs: 600,
  });
  assert.match(renderDiscoveryTimingSummary(summary), /wall 2\.0s/);
  assert.match(renderDiscoveryTimingSummary(summary), /CAPTCHA 1/);
});

test('writeDiscoveryTimingArtifact writes an attempt-scoped immutable filename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'discovery-timing-'));
  const recorder = new DiscoveryTimingRecorder(Date.parse('2026-09-01T00:00:00.000Z'));
  recorder.recordBrowser(rootSample);
  const summary = recorder.snapshot({
    runId: 'run-2',
    mode: 'fresh',
    state: 'completed',
    finishedAtMs: Date.parse('2026-09-01T00:00:01.000Z'),
  });

  const path = await writeDiscoveryTimingArtifact(directory, summary);
  assert.match(path, /discovery-timing-2026-09-01T00-00-00-000Z\.json$/);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { runId: string; scope: string };
  assert.equal(parsed.runId, 'run-2');
  assert.equal(parsed.scope, 'process_attempt');
});
