import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import type { Page } from 'playwright-core';
import { waitForManualCaptcha, pauseForManualCaptcha, NEVER_CANCELLED } from './captcha.js';
import { ResearchError } from '../shared/errors.js';

const CAPTCHA_SELECTOR_FOR_TEST = 'form[action*="sorry"], iframe[src*="recaptcha"], #captcha';

function fakePage(opts: { captchaVisible: boolean; bodyText: string; rotateCookiesPage?: boolean }): Page {
  const page = {
    locator: (_sel: string) => ({
      count: async () => (opts.captchaVisible ? 1 : 0),
      innerText: async () => opts.bodyText,
    }),
    isClosed: () => false,
    url: () => 'https://www.google.com/search?q=test',
    waitForLoadState: async () => undefined,
  } as unknown as Page;
  const rotatePage = {
    isClosed: () => false,
    url: () => 'https://accounts.google.com/RotateCookiesPage?origin=https%3A%2F%2Fwww.google.com',
  } as unknown as Page;
  (page as unknown as { context: () => { pages: () => Page[] } }).context = () => ({
    pages: () => (opts.rotateCookiesPage ? [page, rotatePage] : [page]),
  });
  return page;
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

test('waitForManualCaptcha pauses immediately for a RotateCookiesPage bot challenge', async () => {
  const page = fakePage({
    captchaVisible: false,
    bodyText: 'Our systems have detected unusual traffic from your computer network.',
    rotateCookiesPage: true,
  });
  await assert.rejects(
    () => waitForManualCaptcha(page),
    (error: unknown) =>
      error instanceof ResearchError &&
      error.code === 'RUN_PAUSED' &&
      error.message.includes('RotateCookiesPage'),
  );
});

test('waitForManualCaptcha ignores a standalone RotateCookiesPage without challenge markers', async () => {
  await waitForManualCaptcha(fakePage({
    captchaVisible: false,
    bodyText: 'normal search results',
    rotateCookiesPage: true,
  }));
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

test('pauseForManualCaptcha stops waiting if RotateCookiesPage appears', async () => {
  const state = {
    captchaVisible: true,
    bodyText: 'unusual traffic',
    rotateCookiesPage: false,
  };
  const timer = setTimeout(() => {
    state.rotateCookiesPage = true;
  }, 20);

  try {
    await assert.rejects(
      () => pauseForManualCaptcha(fakePage(state), NEVER_CANCELLED, {
        pollIntervalMs: 5,
        timeoutMs: 1000,
      }),
      (error: unknown) => error instanceof ResearchError && error.code === 'RUN_PAUSED',
    );
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

test('pauseForManualCaptcha retries a transient page-inspection failure instead of resuming', async () => {
  let selectorChecks = 0;
  const page = {
    isClosed: () => false,
    locator: (selector: string) => ({
      count: async () => {
        selectorChecks += 1;
        if (selectorChecks === 1) return 1;
        if (selectorChecks === 2) throw new Error('Execution context was destroyed');
        if (selector === CAPTCHA_SELECTOR_FOR_TEST) return selectorChecks === 3 ? 1 : 0;
        return 0;
      },
      innerText: async () => 'normal search results',
    }),
    context: () => ({ pages: () => [] }),
    waitForLoadState: async () => undefined,
  } as unknown as Page;

  const solved = await pauseForManualCaptcha(page, NEVER_CANCELLED, {
    pollIntervalMs: 1,
    timeoutMs: 1000,
  });

  assert.equal(solved, true);
  assert.ok(selectorChecks >= 4, 'must retry after the transient failure before resuming');
});

test('pauseForManualCaptcha reports a closed page instead of pretending CAPTCHA was solved', async () => {
  const page = {
    isClosed: () => true,
    locator: () => {
      throw new Error('must not inspect a closed page');
    },
  } as unknown as Page;

  await assert.rejects(
    () => pauseForManualCaptcha(page, NEVER_CANCELLED, { pollIntervalMs: 1, timeoutMs: 100 }),
    (error: unknown) => error instanceof ResearchError && error.code === 'GOOGLE_UNAVAILABLE',
  );
});
