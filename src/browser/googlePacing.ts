import type { BrowserCollectionTiming } from './collect.js';

/**
 * Carries a conservative delay budget from an accelerated root collection to
 * the next Google browser call. The budget does NOT expire while Ahrefs/cache/
 * snapshot work runs: the legacy pipeline performed that same work after the
 * slower collector, so allowing it to consume this budget would still make the
 * next Google navigation earlier than before.
 */
export class GoogleLegacyCadencePacer {
  private pendingDelayMs = 0;

  observe(sample: BrowserCollectionTiming): number {
    const holdMs = conservativeLegacyHoldMs(sample);
    if (holdMs <= 0) return 0;
    this.pendingDelayMs = Math.max(this.pendingDelayMs, holdMs);
    return holdMs;
  }

  async wait(params: {
    sleep: (ms: number) => Promise<void>;
  }): Promise<number> {
    const delayMs = this.pendingDelayMs;
    if (delayMs <= 0) return 0;
    await params.sleep(delayMs);
    this.pendingDelayMs = 0;
    return delayMs;
  }
}

/**
 * PERF-B only moves the root Related lazy-mount trigger (scroll) ahead of main
 * Surfer completion. The terminal Related reader still starts after main Surfer
 * plus the historical 1000 ms warm-up, so missing/error deadlines do not move
 * earlier. Moving the mount trigger earlier can save at most roughly the amount
 * of time main Surfer itself was pending. Paying that full duration before the
 * next Google browser call is intentionally conservative and prevents this
 * optimization itself from increasing Google request cadence.
 *
 * Expanded children do not read Related, and related-only cache repair keeps its
 * old scroll + 1000 ms + reader sequence, so neither needs compensation.
 */
export function conservativeLegacyHoldMs(sample: BrowserCollectionTiming): number {
  if (sample.kind !== 'primary' || !sample.isRoot || sample.mainSurferMs === null) {
    return 0;
  }
  return Math.max(0, Math.round(sample.mainSurferMs));
}
