import type { BrowserCollectionTiming } from './collect.js';

/**
 * Keeps the next Google navigation from becoming more aggressive merely because
 * Related lazy-mount work was moved earlier. The hold is context-local and can
 * naturally expire while post-collection work (for example Ahrefs) is running.
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
 * PERF-B only moves the root Related lazy-mount trigger (scroll) ahead of main
 * Surfer completion. The terminal Related reader still starts after main Surfer
 * plus the historical 1000 ms warm-up, so missing/error deadlines do not move
 * earlier. Moving the mount trigger earlier can at most recover roughly the
 * amount of time main Surfer itself was pending. Holding that full main-Surfer
 * duration after collection is intentionally conservative: it prevents this
 * optimization from increasing Google navigation cadence by default. Ahrefs or
 * other work between browser calls can consume the hold without extra sleeping.
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
