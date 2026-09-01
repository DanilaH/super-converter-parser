import type { BrowserCollectionTiming } from './collect.js';

/**
 * Keeps the next Google navigation from starting earlier than a conservative
 * floor derived from the pre-PERF-B serial collector while allowing recovered
 * wait time to overlap post-collection work such as Ahrefs.
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
  }): Promise<number> {
    const remainingMs = Math.max(0, this.notBeforeMs - params.now());
    if (remainingMs <= 0) return 0;
    await params.sleep(remainingMs);
    return remainingMs;
  }
}

/**
 * Before PERF-B, root collection waited for main Surfer, then an unconditional
 * 1000 ms, then Surfer Related. PERF-B overlaps the two Surfer readers and
 * removes that fixed sleep. `min(main, related) + 1000` is therefore a
 * conservative estimate of serial time that could have been removed. SERP and
 * location remain after both readers, so their measured time has already
 * consumed part of that recovered interval before collection returns.
 *
 * This intentionally overestimates rather than underestimates when Related was
 * already becoming ready while main Surfer was pending. The default therefore
 * cannot make Google cadence more aggressive merely because collection became
 * faster. A future evidence-backed pacing policy may relax this floor.
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
