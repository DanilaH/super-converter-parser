import type { BrowserCollectionTiming } from '../browser/collect.js';

export type GooglePacingWait = {
  requestedMs: number;
  remainingMs: number;
};

/**
 * Keeps the next Google navigation from starting earlier than the old serial
 * collector's conservative cadence floor while allowing the recovered wait to
 * overlap post-collection work (notably Ahrefs). This is intentionally not a
 * fixed anti-bot interval and does not invent a new policy value.
 */
export class GoogleLegacyCadencePacer {
  private notBeforeMs = 0;

  observe(sample: BrowserCollectionTiming, observedAtMs: number): number {
    const holdMs = conservativeLegacyHoldMs(sample);
    if (holdMs <= 0) return 0;
    this.notBeforeMs = Math.max(this.notBeforeMs, observedAtMs + holdMs);
    return holdMs;
  }

  async wait(params: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    onWait?: (wait: GooglePacingWait) => void;
  }): Promise<number> {
    const remainingMs = Math.max(0, this.notBeforeMs - params.now());
    if (remainingMs <= 0) return 0;
    params.onWait?.({ requestedMs: this.notBeforeMs, remainingMs });
    await params.sleep(remainingMs);
    return remainingMs;
  }
}

/**
 * PERF-B starts main Surfer and Related together. Before PERF-B they were
 * sequential and root collection also included an unconditional 1000 ms wait
 * before Related. `min(main, related) + 1000` is a conservative amount of
 * serial time that overlap could remove from a root collection. SERP and
 * location work still happen after both Surfer observations, so their measured
 * durations can already consume part of that recovered time before the
 * collector returns. Any remaining hold can then overlap Ahrefs work in the
 * engine before the next browser collection starts.
 *
 * Related-only cache repair previously had the same fixed 1000 ms wait, so it
 * keeps a 1000 ms floor. Expanded child keywords never read Related and need no
 * pacing compensation.
 */
export function conservativeLegacyHoldMs(sample: BrowserCollectionTiming): number {
  if (sample.kind === 'related_only') {
    return sample.relatedSurferMs === null ? 0 : 1000;
  }
  if (!sample.isRoot || sample.mainSurferMs === null || sample.relatedSurferMs === null) {
    return 0;
  }

  const recoveredSerialMs = Math.min(sample.mainSurferMs, sample.relatedSurferMs) + 1000;
  const postSurferMs = (sample.serpParseMs ?? 0) + (sample.locationParseMs ?? 0);
  return Math.max(0, Math.round(recoveredSerialMs - postSurferMs));
}
