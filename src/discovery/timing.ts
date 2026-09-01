import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserCollectionTiming } from '../browser/collect.js';
import type { SnapshotCadenceReason } from './snapshotCadence.js';

export type AhrefsTimingStatus = 'ok' | 'not_found' | 'error' | 'throw';

export type AhrefsTimingSample = {
  domain: string;
  durationMs: number;
  status: AhrefsTimingStatus;
};

export type SnapshotTimingSample = {
  state: string;
  reason: SnapshotCadenceReason;
  published: boolean;
  durationMs: number;
};

export type TimingDistribution = {
  count: number;
  minMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  averageMs: number | null;
};

export type DiscoveryTimingSummaryV1 = {
  version: 1;
  scope: 'process_attempt';
  runId: string;
  mode: 'fresh' | 'resume';
  state: string | null;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  counts: {
    primaryBrowserCollections: number;
    relatedOnlyBrowserCollections: number;
    rootPrimaryCollections: number;
    expandedPrimaryCollections: number;
    captchaEncounters: number;
    relatedOk: number;
    relatedEmpty: number;
    relatedError: number;
    ahrefsClientCalls: number;
    engineSleepCalls: number;
    snapshotCallbacks: number;
    snapshotPublishes: number;
    snapshotSkips: number;
  };
  totals: {
    browserCollectionMs: number;
    navigationMs: number;
    captchaMs: number;
    mainSurferMs: number;
    relatedSurferMs: number;
    serpParseMs: number;
    locationParseMs: number;
    ahrefsClientMs: number;
    engineSleepRequestedMs: number;
    snapshotPublishMs: number;
  };
  distributions: {
    primaryBrowserCollectionMs: TimingDistribution;
    relatedOnlyBrowserCollectionMs: TimingDistribution;
    relatedSurferMs: TimingDistribution;
    ahrefsClientMs: TimingDistribution;
    snapshotPublishMs: TimingDistribution;
  };
  browserSamples: BrowserCollectionTiming[];
  ahrefsSamples: AhrefsTimingSample[];
  snapshotSamples: SnapshotTimingSample[];
};

export class DiscoveryTimingRecorder {
  private readonly browserSamples: BrowserCollectionTiming[] = [];
  private readonly ahrefsSamples: AhrefsTimingSample[] = [];
  private readonly snapshotSamples: SnapshotTimingSample[] = [];
  private engineSleepCalls = 0;
  private engineSleepRequestedMs = 0;

  constructor(private readonly startedAtMs: number = Date.now()) {}

  recordBrowser(sample: BrowserCollectionTiming): void {
    this.browserSamples.push({ ...sample });
  }

  recordAhrefs(domain: string, durationMs: number, status: AhrefsTimingStatus): void {
    this.ahrefsSamples.push({ domain, durationMs: nonNegative(durationMs), status });
  }

  recordSleep(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.engineSleepCalls += 1;
    this.engineSleepRequestedMs += ms;
  }

  recordSnapshot(state: string, reason: SnapshotCadenceReason, published: boolean, durationMs: number): void {
    this.snapshotSamples.push({ state, reason, published, durationMs: nonNegative(durationMs) });
  }

  snapshot(params: {
    runId: string;
    mode: 'fresh' | 'resume';
    state: string | null;
    finishedAtMs?: number;
  }): DiscoveryTimingSummaryV1 {
    const finishedAtMs = params.finishedAtMs ?? Date.now();
    const primary = this.browserSamples.filter((sample) => sample.kind === 'primary');
    const relatedOnly = this.browserSamples.filter((sample) => sample.kind === 'related_only');
    const relatedDurations = this.browserSamples
      .map((sample) => sample.relatedSurferMs)
      .filter((value): value is number => value !== null);
    const ahrefsDurations = this.ahrefsSamples.map((sample) => sample.durationMs);
    const publishedSnapshots = this.snapshotSamples.filter((sample) => sample.published);
    const snapshotDurations = publishedSnapshots.map((sample) => sample.durationMs);

    return {
      version: 1,
      scope: 'process_attempt',
      runId: params.runId,
      mode: params.mode,
      state: params.state,
      startedAt: new Date(this.startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      wallMs: nonNegative(finishedAtMs - this.startedAtMs),
      counts: {
        primaryBrowserCollections: primary.length,
        relatedOnlyBrowserCollections: relatedOnly.length,
        rootPrimaryCollections: primary.filter((sample) => sample.isRoot).length,
        expandedPrimaryCollections: primary.filter((sample) => !sample.isRoot).length,
        captchaEncounters: this.browserSamples.filter((sample) => sample.captchaEncountered).length,
        relatedOk: this.browserSamples.filter((sample) => sample.relatedOutcome === 'ok').length,
        relatedEmpty: this.browserSamples.filter((sample) => sample.relatedOutcome === 'empty').length,
        relatedError: this.browserSamples.filter((sample) => sample.relatedOutcome === 'error').length,
        ahrefsClientCalls: this.ahrefsSamples.length,
        engineSleepCalls: this.engineSleepCalls,
        snapshotCallbacks: this.snapshotSamples.length,
        snapshotPublishes: publishedSnapshots.length,
        snapshotSkips: this.snapshotSamples.length - publishedSnapshots.length,
      },
      totals: {
        browserCollectionMs: sum(this.browserSamples.map((sample) => sample.totalMs)),
        navigationMs: sumNullable(this.browserSamples.map((sample) => sample.navigationMs)),
        captchaMs: sumNullable(this.browserSamples.map((sample) => sample.captchaMs)),
        mainSurferMs: sumNullable(this.browserSamples.map((sample) => sample.mainSurferMs)),
        relatedSurferMs: sum(relatedDurations),
        serpParseMs: sumNullable(this.browserSamples.map((sample) => sample.serpParseMs)),
        locationParseMs: sumNullable(this.browserSamples.map((sample) => sample.locationParseMs)),
        ahrefsClientMs: sum(ahrefsDurations),
        engineSleepRequestedMs: this.engineSleepRequestedMs,
        snapshotPublishMs: sum(snapshotDurations),
      },
      distributions: {
        primaryBrowserCollectionMs: distribution(primary.map((sample) => sample.totalMs)),
        relatedOnlyBrowserCollectionMs: distribution(relatedOnly.map((sample) => sample.totalMs)),
        relatedSurferMs: distribution(relatedDurations),
        ahrefsClientMs: distribution(ahrefsDurations),
        snapshotPublishMs: distribution(snapshotDurations),
      },
      browserSamples: this.browserSamples.map((sample) => ({ ...sample })),
      ahrefsSamples: this.ahrefsSamples.map((sample) => ({ ...sample })),
      snapshotSamples: this.snapshotSamples.map((sample) => ({ ...sample })),
    };
  }
}

export async function writeDiscoveryTimingArtifact(
  runDirectory: string,
  summary: DiscoveryTimingSummaryV1,
): Promise<string> {
  const safeStartedAt = summary.startedAt.replace(/[:.]/g, '-');
  const path = join(runDirectory, `discovery-timing-${safeStartedAt}.json`);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await rename(tempPath, path);
    return path;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function renderDiscoveryTimingSummary(summary: DiscoveryTimingSummaryV1): string {
  const totals = summary.totals;
  return [
    `wall ${formatMs(summary.wallMs)}`,
    `browser ${formatMs(totals.browserCollectionMs)}`,
    `related ${formatMs(totals.relatedSurferMs)}`,
    `Ahrefs client ${formatMs(totals.ahrefsClientMs)}`,
    `engine sleeps ${formatMs(totals.engineSleepRequestedMs)}`,
    `snapshots ${formatMs(totals.snapshotPublishMs)} (${summary.counts.snapshotPublishes} write / ${summary.counts.snapshotSkips} skip)`,
    `CAPTCHA ${summary.counts.captchaEncounters}`,
  ].join(' | ');
}

function distribution(values: number[]): TimingDistribution {
  if (values.length === 0) {
    return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null, averageMs: null };
  }
  const sorted = values.map(nonNegative).sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? null,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? null,
    averageMs: Math.round(sum(sorted) / sorted.length),
  };
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(sorted.length * fraction));
  return sorted[rank - 1] ?? null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + nonNegative(value), 0);
}

function sumNullable(values: Array<number | null>): number {
  return sum(values.filter((value): value is number => value !== null));
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function formatMs(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}
