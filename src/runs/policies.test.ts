import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, isTransientErrorCode, retryDelayMs } from './policies.js';
import type { RetrySettings } from './policies.js';

const RETRY: RetrySettings = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };

test('retryDelayMs applies half-jitter exponential backoff with a cap', () => {
  // random() === 0.5 => delay = min(base * 2^(attempt-1), cap) * 0.75
  assert.equal(retryDelayMs(1, RETRY, () => 0.5), 75);
  assert.equal(retryDelayMs(2, RETRY, () => 0.5), 150);
  assert.equal(retryDelayMs(3, RETRY, () => 0.5), 300);
  assert.equal(retryDelayMs(4, RETRY, () => 0.5), 600);
  assert.equal(retryDelayMs(5, RETRY, () => 0.5), 750); // capped at 1000 * 0.75
});

test('retryDelayMs honors the cap for random() === 1', () => {
  assert.equal(retryDelayMs(9, RETRY, () => 1), 1_000);
});

test('only GOOGLE_UNAVAILABLE is transient', () => {
  assert.equal(isTransientErrorCode('GOOGLE_UNAVAILABLE'), true);
  assert.equal(isTransientErrorCode('SURFER_PARSE_ERROR'), false);
  assert.equal(isTransientErrorCode('GOOGLE_SERP_PARSE_ERROR'), false);
  assert.equal(isTransientErrorCode('SURFER_NOT_DETECTED'), false);
});

test('surfer breaker trips when the window is full of failures', () => {
  const breaker = new CircuitBreaker({
    surferWindow: 3,
    surferFailureThreshold: 3,
    googleConsecutiveThreshold: 10,
  });
  assert.equal(breaker.tripReason(), null);
  breaker.record('failed', 'SURFER_PARSE_ERROR');
  breaker.record('failed', 'SURFER_PARSE_ERROR');
  assert.equal(breaker.tripReason(), null);
  breaker.record('failed', 'SURFER_PARSE_ERROR');
  assert.match(breaker.tripReason() ?? '', /Keyword Surfer/);
});

test('surfer breaker window slides past older failures', () => {
  const breaker = new CircuitBreaker({
    surferWindow: 3,
    surferFailureThreshold: 3,
    googleConsecutiveThreshold: 10,
  });
  for (let i = 0; i < 3; i += 1) breaker.record('failed', 'SURFER_PARSE_ERROR');
  breaker.record('completed', null);
  breaker.record('completed', null);
  assert.equal(breaker.tripReason(), null);
});

test('google breaker trips after consecutive parse failures', () => {
  const breaker = new CircuitBreaker({
    surferWindow: 15,
    surferFailureThreshold: 12,
    googleConsecutiveThreshold: 3,
  });
  breaker.record('partial', 'GOOGLE_SERP_PARSE_ERROR');
  breaker.record('partial', 'GOOGLE_SERP_PARSE_ERROR');
  assert.equal(breaker.tripReason(), null);
  breaker.record('partial', 'GOOGLE_SERP_PARSE_ERROR');
  assert.match(breaker.tripReason() ?? '', /Google/);
});

test('google breaker resets on a successful result', () => {
  const breaker = new CircuitBreaker({
    surferWindow: 15,
    surferFailureThreshold: 12,
    googleConsecutiveThreshold: 3,
  });
  breaker.record('partial', 'GOOGLE_SERP_PARSE_ERROR');
  breaker.record('partial', 'GOOGLE_SERP_PARSE_ERROR');
  breaker.record('completed', null);
  breaker.record('partial', 'GOOGLE_SERP_PARSE_ERROR');
  breaker.record('partial', 'GOOGLE_SERP_PARSE_ERROR');
  assert.equal(breaker.tripReason(), null);
});

test('surfer failures do not count toward the google breaker and vice versa', () => {
  const breaker = new CircuitBreaker({
    surferWindow: 15,
    surferFailureThreshold: 12,
    googleConsecutiveThreshold: 3,
  });
  breaker.record('failed', 'SURFER_PARSE_ERROR');
  breaker.record('failed', 'SURFER_PARSE_ERROR');
  breaker.record('failed', 'SURFER_PARSE_ERROR');
  assert.equal(breaker.tripReason(), null); // google counter untouched
});