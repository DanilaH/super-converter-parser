import { ResearchError } from '../shared/errors.js';

export const DEFAULT_GOOGLE_MIN_NAVIGATION_INTERVAL_MS = 2_000;
const CANCELLATION_POLL_MS = 100;

/**
 * Operational burst floor between browser collection starts. It deliberately
 * lives outside research semantics/fingerprints: its purpose is to keep local
 * performance improvements from accidentally increasing Google request cadence.
 * This is not a CAPTCHA guarantee and does not add concurrency.
 */
export class GoogleNavigationGate {
  private lastStartedAtMs: number | null = null;

  constructor(private readonly minIntervalMs: number = DEFAULT_GOOGLE_MIN_NAVIGATION_INTERVAL_MS) {
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) {
      throw new Error(`minIntervalMs must be a non-negative number, got ${minIntervalMs}`);
    }
  }

  async waitForTurn(params: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    isCancelled: () => boolean;
  }): Promise<number> {
    const waitStartedAt = params.now();

    while (this.lastStartedAtMs !== null && this.minIntervalMs > 0) {
      if (params.isCancelled()) throw pausedError();
      const remainingMs = this.lastStartedAtMs + this.minIntervalMs - params.now();
      if (remainingMs <= 0) break;
      await params.sleep(Math.min(remainingMs, CANCELLATION_POLL_MS));
    }

    if (params.isCancelled()) throw pausedError();
    const startedAt = params.now();
    this.lastStartedAtMs = startedAt;
    return Math.max(0, startedAt - waitStartedAt);
  }
}

function pausedError(): ResearchError {
  return new ResearchError(
    'RUN_PAUSED',
    'Collection cancelled while waiting for the Google navigation cadence gate.',
  );
}
