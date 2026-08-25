import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import type { Page } from 'playwright-core';
import { waitForManualCaptcha, pauseForManualCaptcha, NEVER_CANCELLED } from './captcha.js';
import { ResearchError } from '../shared/errors.js';

function fakePage(opts: { captchaVisible: boolean; bodyText: string }): Page {
  return {
    locator: (_sel: string) => ({
      count: async () => (opts.captchaVisible ? 1 : 0),
      innerText: async () => opts.bodyText,
    }),
    waitForLoadState: async () => undefined,
  } as unknown as Page;
}

test('waitForManualCaptcha throws CAPTCHA_REQUIRED when a captcha widget is present', async () => {
  const page = fakePage({ captchaVisible: true, bodyText: 'normal' });
  await assert.rejects(
    () => waitForManualCaptcha(page),
    (error: unknown) => error instanceof ResearchError && error.code === 'CAPTCHA_REQUIRED',
  );
});

test('waitForManualCaptcha returns silently when no captcha is detected', async () => {
  await waitForManualCaptcha(fakePage({ captchaVisible: false, bodyText: 'normal search results' }));
});

test('waitForManualCaptcha detects captcha by body text', async () => {
  const page = fakePage({ captchaVisible: false, bodyText: 'Please verify you are not a robot' });
  await assert.rejects(
    () => waitForManualCaptcha(page),
    (error: unknown) => error instanceof ResearchError && error.code === 'CAPTCHA_REQUIRED',
  );
});

test('pauseForManualCaptcha polls the page and resumes automatically when CAPTCHA disappears', async () => {
  const state = { captchaVisible: true, bodyText: 'unusual traffic' };
  const timer = setTimeout(() => {
    state.captchaVisible = false;
    state.bodyText = 'normal search results';
  }, 20);

  try {
    const solved = await pauseForManualCaptcha(fakePage(state), NEVER_CANCELLED, {
      pollIntervalMs: 5,
      timeoutMs: 1000,
    });
    assert.equal(solved, true);
  } finally {
    clearTimeout(timer);
  }
});

test('pauseForManualCaptcha returns solved=false when the shared signal is cancelled', async () => {
  const signal = { isCancelled: () => false };
  const timer = setTimeout(() => {
    signal.isCancelled = () => true;
  }, 20);

  const start = Date.now();
  try {
    const solved = await pauseForManualCaptcha(
      fakePage({ captchaVisible: true, bodyText: 'unusual traffic' }),
      signal,
      { pollIntervalMs: 5, timeoutMs: 1000 },
    );
    assert.equal(solved, false);
  } finally {
    clearTimeout(timer);
  }
  assert.ok(Date.now() - start < 5000, 'must not wait for the timeout');
});

test('pauseForManualCaptcha times out without pretending CAPTCHA was solved', async () => {
  const page = fakePage({ captchaVisible: true, bodyText: 'unusual traffic' });
  await assert.rejects(
    () => pauseForManualCaptcha(page, NEVER_CANCELLED, { pollIntervalMs: 5, timeoutMs: 20 }),
    (error: unknown) => error instanceof ResearchError && error.code === 'CAPTCHA_REQUIRED',
  );
});

test('pauseForManualCaptcha does not register its own SIGINT listener', async () => {
  const before = process.listenerCount('SIGINT');
  const solved = await pauseForManualCaptcha(
    fakePage({ captchaVisible: true, bodyText: 'unusual traffic' }),
    { isCancelled: () => true },
  );
  assert.equal(solved, false);
  assert.equal(process.listenerCount('SIGINT'), before);
});
