import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { Page } from 'playwright-core';
import { waitForManualCaptcha, pauseForManualCaptcha } from './captcha.js';
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

test('pauseForManualCaptcha (non-TTY) waits for the marker file and removes it', async () => {
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
  try {
    await pauseForManualCaptcha(page);
  } finally {
    clearTimeout(timer);
    Object.defineProperty(process.stdin, 'isTTY', { value: originalTty, configurable: true });
    if (originalMarker === undefined) delete process.env.CAPTCHA_DONE_MARKER;
    else process.env.CAPTCHA_DONE_MARKER = originalMarker;
  }

  assert.ok(Date.now() - start >= 150, 'should have waited for the marker before resuming');
  assert.equal(existsSync(marker), false, 'marker must be consumed/removed after resume');
});

test('pauseForManualCaptcha (non-TTY) returns on the first Ctrl+C instead of waiting for the marker', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'captcha-marker-int-')), 'done.txt');
  rmSync(marker, { force: true });

  const originalTty = (process.stdin as { isTTY?: boolean }).isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  const originalMarker = process.env.CAPTCHA_DONE_MARKER;
  process.env.CAPTCHA_DONE_MARKER = marker;

  const page = { waitForLoadState: async () => undefined } as unknown as Page;
  const timer = setTimeout(() => {
    process.emit('SIGINT');
  }, 300);

  const start = Date.now();
  try {
    await pauseForManualCaptcha(page);
  } finally {
    clearTimeout(timer);
    Object.defineProperty(process.stdin, 'isTTY', { value: originalTty, configurable: true });
    if (originalMarker === undefined) delete process.env.CAPTCHA_DONE_MARKER;
    else process.env.CAPTCHA_DONE_MARKER = originalMarker;
  }

  assert.ok(Date.now() - start < 5000, 'must not wait for the (absent) marker or the timeout');
  assert.equal(existsSync(marker), false, 'no marker was created, so nothing to remove');
});
