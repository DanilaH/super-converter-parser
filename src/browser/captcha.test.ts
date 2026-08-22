import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const page = fakePage({ captchaVisible: false, bodyText: 'normal search results' });
  await waitForManualCaptcha(page); // must not throw
});

test('waitForManualCaptcha detects captcha by body text', async () => {
  const page = fakePage({ captchaVisible: false, bodyText: 'Please verify you are not a robot' });
  await assert.rejects(
    () => waitForManualCaptcha(page),
    (error: unknown) => error instanceof ResearchError && error.code === 'CAPTCHA_REQUIRED',
  );
});

test('pauseForManualCaptcha (non-TTY) waits for the marker file, removes it, and returns solved=true', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'captcha-marker-')), 'done.txt');
  rmSync(marker, { force: true });

  const originalTty = (process.stdin as { isTTY?: boolean }).isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  const originalMarker = process.env.CAPTCHA_DONE_MARKER;
  process.env.CAPTCHA_DONE_MARKER = marker;

  const page = { waitForLoadState: async () => undefined } as unknown as Page;
  const timer = setTimeout(() => {
    void writeFile(marker, 'done');
  }, 300);

  const start = Date.now();
  let solved: boolean;
  try {
    solved = await pauseForManualCaptcha(page, NEVER_CANCELLED);
  } finally {
    clearTimeout(timer);
    Object.defineProperty(process.stdin, 'isTTY', { value: originalTty, configurable: true });
    if (originalMarker === undefined) delete process.env.CAPTCHA_DONE_MARKER;
    else process.env.CAPTCHA_DONE_MARKER = originalMarker;
  }

  assert.equal(solved, true, 'returning after the marker must report solved=true');
  assert.ok(Date.now() - start >= 150, 'should have waited for the marker before resuming');
  assert.equal(existsSync(marker), false, 'marker must be consumed/removed after resume');
});

test('pauseForManualCaptcha (non-TTY) returns solved=false when the shared signal is cancelled', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'captcha-marker-int-')), 'done.txt');
  rmSync(marker, { force: true });

  const originalTty = (process.stdin as { isTTY?: boolean }).isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  const originalMarker = process.env.CAPTCHA_DONE_MARKER;
  process.env.CAPTCHA_DONE_MARKER = marker;

  const signal = { isCancelled: () => false };
  const page = { waitForLoadState: async () => undefined } as unknown as Page;
  const timer = setTimeout(() => {
    signal.isCancelled = () => true;
  }, 300);

  const start = Date.now();
  let solved: boolean;
  try {
    solved = await pauseForManualCaptcha(page, signal);
  } finally {
    clearTimeout(timer);
    Object.defineProperty(process.stdin, 'isTTY', { value: originalTty, configurable: true });
    if (originalMarker === undefined) delete process.env.CAPTCHA_DONE_MARKER;
    else process.env.CAPTCHA_DONE_MARKER = originalMarker;
  }

  assert.equal(solved, false, 'a cancelled wait must report solved=false (never pretend the CAPTCHA was solved)');
  assert.ok(Date.now() - start < 5000, 'must not wait for the (absent) marker or the timeout');
  assert.equal(existsSync(marker), false, 'no marker was created, so nothing to remove');
});

test('pauseForManualCaptcha does not register its own SIGINT listener (force-quit stays with the CLI)', async () => {
  const before = process.listenerCount('SIGINT');
  const page = { waitForLoadState: async () => undefined } as unknown as Page;
  // The CLI owns SIGINT handling; the helper must poll the shared signal rather
  // than adding its own listener. With an already-cancelled signal it returns at
  // once, so the listener count must be unchanged afterwards.
  const solved = await pauseForManualCaptcha(page, { isCancelled: () => true });
  const after = process.listenerCount('SIGINT');
  assert.equal(solved, false, 'cancelled signal returns solved=false');
  assert.equal(after, before, 'the helper must not add or leak a SIGINT listener');
});
