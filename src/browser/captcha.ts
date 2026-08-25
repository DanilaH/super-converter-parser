import type { Page } from 'playwright-core';
import { ResearchError } from '../shared/errors.js';

// Unified cancellation signal owned by the CLI. The CAPTCHA helper must never
// register its own SIGINT listener; it polls the signal owned by the CLI.
export type CancellationSignal = { isCancelled: () => boolean };

export const NEVER_CANCELLED: CancellationSignal = { isCancelled: () => false };

const CAPTCHA_SELECTOR = 'form[action*="sorry"], iframe[src*="recaptcha"], #captcha';
const CAPTCHA_TEXT = /unusual traffic|not a robot|captcha/i;

async function captchaIsPresent(page: Page): Promise<boolean> {
  const captchaVisible = await page
    .locator(CAPTCHA_SELECTOR)
    .count()
    .then((count) => count > 0)
    .catch(() => false);

  if (captchaVisible) return true;

  return page
    .locator('body')
    .innerText()
    .then((text) => CAPTCHA_TEXT.test(text))
    .catch(() => false);
}

export async function waitForManualCaptcha(page: Page): Promise<void> {
  if (!(await captchaIsPresent(page))) return;

  throw new ResearchError(
    'CAPTCHA_REQUIRED',
    'Google is asking for manual verification. Solve the CAPTCHA in Research Chrome; the runner will continue automatically.',
  );
}

export type CaptchaWaitOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
};

async function cancellableDelay(ms: number, signal: CancellationSignal): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (signal.isCancelled()) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, deadline - Date.now())));
  }
  return !signal.isCancelled();
}

// Waits for the operator to clear the CAPTCHA in Research Chrome. The page is
// polled directly, so neither Enter nor a marker file is required. Returns
// `false` only when the shared cancellation signal is set; callers then leave
// the active item resumable.
export async function pauseForManualCaptcha(
  page: Page,
  signal: CancellationSignal = NEVER_CANCELLED,
  options: CaptchaWaitOptions = {},
): Promise<boolean> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  console.log('\nGoogle просит ручную проверку.');
  console.log('Реши CAPTCHA в окне Research Chrome.');
  console.log('После решения runner продолжит автоматически (Ctrl+C — поставить run на паузу).');

  const start = Date.now();
  while (await captchaIsPresent(page)) {
    if (signal.isCancelled()) return false;
    if (Date.now() - start >= timeoutMs) {
      throw new ResearchError('CAPTCHA_REQUIRED', 'CAPTCHA wait timeout; run remains resumable.');
    }
    if (!(await cancellableDelay(pollIntervalMs, signal))) return false;
  }

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  console.log('CAPTCHA решена — продолжаю.');
  return true;
}
