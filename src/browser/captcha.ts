import { createInterface } from 'node:readline/promises';
import { existsSync, rmSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { ResearchError } from '../shared/errors.js';

// Unified cancellation signal owned by the CLI. The CAPTCHA helper must never
// register its own SIGINT listener (that would interfere with the CLI's
// first-Ctrl+C pause / second-Ctrl+C force-quit handling); instead it polls
// `isCancelled()` which the CLI flips when SIGINT arrives.
export type CancellationSignal = { isCancelled: () => boolean };

export const NEVER_CANCELLED: CancellationSignal = { isCancelled: () => false };

export async function waitForManualCaptcha(page: Page): Promise<void> {
  const captchaVisible = await page
    .locator('form[action*="sorry"], iframe[src*="recaptcha"], #captcha')
    .count();

  const blockedByText = await page
    .locator('body')
    .innerText()
    .then((text) => /unusual traffic|not a robot|captcha/i.test(text))
    .catch(() => false);

  if (!captchaVisible && !blockedByText) return;

  throw new ResearchError(
    'CAPTCHA_REQUIRED',
    'Google is asking for manual verification. Solve the CAPTCHA in Research Chrome, then press Enter here.',
  );
}

// Waits for the operator to clear the CAPTCHA. Returns `true` once it is solved
// (Enter in a TTY, or the marker file created in a background run) and `false`
// if the run was cancelled via the shared signal before the CAPTCHA cleared.
// On cancel it does NOT consume the marker and does NOT assume the page reloaded;
// the caller must treat `false` as "collection aborted, keyword left resumable".
export async function pauseForManualCaptcha(
  page: Page,
  signal: CancellationSignal = NEVER_CANCELLED,
): Promise<boolean> {
  console.log('\nGoogle просит ручную проверку.');
  console.log('Реши CAPTCHA в окне Research Chrome.');

  const marker = process.env.CAPTCHA_DONE_MARKER ?? 'C:\\tmp\\captcha-done.txt';

  if (process.stdin.isTTY) {
    console.log('Затем нажми Enter здесь (Ctrl+C — поставить run на паузу).');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const solved = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        input.close();
        resolve(value);
      };
      input.on('line', () => finish(true));
      const poll = setInterval(() => {
        if (signal.isCancelled()) finish(false);
      }, 200);
    });
    if (solved) await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    return solved;
  }

  console.log(`Затем создай файл-маркер: ${marker} (Ctrl+C — поставить run на паузу).`);
  const start = Date.now();
  while (!existsSync(marker)) {
    if (signal.isCancelled()) return false;
    if (Date.now() - start > 10 * 60 * 1000) {
      throw new ResearchError('CAPTCHA_REQUIRED', 'CAPTCHA wait timeout (marker not created).');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  rmSync(marker, { force: true });
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  return true;
}
