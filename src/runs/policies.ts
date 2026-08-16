import type { ResearchErrorCode } from '../shared/errors.js';
import type { KeywordStatus } from './run.js';

export type RetrySettings = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type BreakerSettings = {
  surferWindow: number;
  surferFailureThreshold: number;
  googleConsecutiveThreshold: number;
};

// Only transient failures are retried: navigation/network problems that may
// succeed on a later attempt. Parser and schema failures are never retried.
export const TRANSIENT_ERROR_CODES: ReadonlySet<ResearchErrorCode> = new Set([
  'GOOGLE_UNAVAILABLE',
]);

const SURFER_PARSER_ERROR_CODES: ReadonlySet<ResearchErrorCode> = new Set([
  'SURFER_NOT_DETECTED',
  'SURFER_PARSE_ERROR',
]);

export function isTransientErrorCode(code: ResearchErrorCode): boolean {
  return TRANSIENT_ERROR_CODES.has(code);
}

// Exponential backoff with half jitter: delay in [exp/2, exp], capped at
// maxDelayMs. `random` is injected so tests stay deterministic.
export function retryDelayMs(
  attempt: number,
  settings: RetrySettings,
  random: () => number,
): number {
  const exponential = Math.min(
    settings.baseDelayMs * 2 ** (attempt - 1),
    settings.maxDelayMs,
  );
  return Math.max(1, Math.round(exponential * (0.5 + random() * 0.5)));
}

export class CircuitBreaker {
  private readonly settings: BreakerSettings;
  // Most recent surfer outcome first; true means the surfer step failed.
  private readonly surferOutcomes: boolean[] = [];
  private consecutiveGoogleFailures = 0;

  constructor(settings: BreakerSettings) {
    this.settings = settings;
  }

  record(status: KeywordStatus, errorCode: ResearchErrorCode | null): void {
    if (errorCode === null) {
      this.recordSurfer(false);
      this.recordGoogle(false);
      return;
    }

    if (SURFER_PARSER_ERROR_CODES.has(errorCode)) {
      this.recordSurfer(true);
    } else if (status === 'completed' || status === 'partial') {
      this.recordSurfer(false);
    }

    if (errorCode === 'GOOGLE_SERP_PARSE_ERROR') {
      this.consecutiveGoogleFailures += 1;
    } else {
      this.recordGoogle(false);
    }
  }

  private recordSurfer(failed: boolean): void {
    this.surferOutcomes.unshift(failed);
    if (this.surferOutcomes.length > this.settings.surferWindow) {
      this.surferOutcomes.length = this.settings.surferWindow;
    }
  }

  private recordGoogle(failed: boolean): void {
    if (!failed) this.consecutiveGoogleFailures = 0;
  }

  tripReason(): string | null {
    if (this.surferOutcomes.length >= this.settings.surferWindow) {
      const failures = this.surferOutcomes.filter(Boolean).length;
      if (failures >= this.settings.surferFailureThreshold) {
        return `Circuit breaker: ${failures} of the last ${this.settings.surferWindow} Keyword Surfer parses failed (threshold ${this.settings.surferFailureThreshold}).`;
      }
    }
    if (this.consecutiveGoogleFailures >= this.settings.googleConsecutiveThreshold) {
      return `Circuit breaker: ${this.consecutiveGoogleFailures} consecutive Google SERP parser failures (threshold ${this.settings.googleConsecutiveThreshold}).`;
    }
    return null;
  }
}