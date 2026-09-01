export const RUNNING_SNAPSHOT_KEYWORD_INTERVAL = 50;
export const RUNNING_SNAPSHOT_TIME_INTERVAL_MS = 60_000;

export type SnapshotCadenceReason = 'first' | 'keyword_interval' | 'time_interval' | 'terminal' | 'skip';

export type SnapshotCadenceDecision = {
  publish: boolean;
  reason: SnapshotCadenceReason;
};

/**
 * Full CSV/JSON/Markdown snapshots are derived outputs; SQLite remains the
 * durable checkpoint after every keyword. Rebuilding every derived artifact on
 * every keyword creates quadratic-ish I/O as a run grows, so running snapshots
 * are bounded by both processed-keyword count and wall time. Terminal/paused
 * publication is never throttled.
 */
export class RunningSnapshotCadence {
  private runningCallsSincePublish = 0;
  private lastPublishedAtMs: number | null = null;

  constructor(
    private readonly keywordInterval: number = RUNNING_SNAPSHOT_KEYWORD_INTERVAL,
    private readonly timeIntervalMs: number = RUNNING_SNAPSHOT_TIME_INTERVAL_MS,
  ) {
    if (!Number.isInteger(keywordInterval) || keywordInterval < 1) {
      throw new Error(`keywordInterval must be a positive integer, got ${keywordInterval}`);
    }
    if (!Number.isFinite(timeIntervalMs) || timeIntervalMs < 0) {
      throw new Error(`timeIntervalMs must be a non-negative number, got ${timeIntervalMs}`);
    }
  }

  decide(state: string, nowMs: number): SnapshotCadenceDecision {
    if (state !== 'running') {
      return { publish: true, reason: 'terminal' };
    }

    this.runningCallsSincePublish += 1;
    if (this.lastPublishedAtMs === null) {
      return { publish: true, reason: 'first' };
    }
    if (this.runningCallsSincePublish >= this.keywordInterval) {
      return { publish: true, reason: 'keyword_interval' };
    }
    if (nowMs - this.lastPublishedAtMs >= this.timeIntervalMs) {
      return { publish: true, reason: 'time_interval' };
    }
    return { publish: false, reason: 'skip' };
  }

  markPublished(nowMs: number): void {
    this.lastPublishedAtMs = nowMs;
    this.runningCallsSincePublish = 0;
  }
}
