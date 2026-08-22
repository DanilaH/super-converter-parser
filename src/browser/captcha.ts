import { createInterface } from 'node:readline/promises';
import { existsSync, rmSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { ResearchError } from '../shared/errors.js';

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

export async function pauseForManualCaptcha(page: Page): Promise<void> {
  console.log('\nGoogle просит ручную проверку.');
  console.log('Реши CAPTCHA в окне Research Chrome.');

  const marker = process.env.CAPTCHA_DONE_MARKER ?? 'C:\\tmp\\captcha-done.txt';

  if (process.stdin.isTTY) {
    console.log('Затем нажми Enter здесь (Ctrl+C — поставить run на паузу).');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let interrupted = false;
    const onSigint = () => {
      interrupted = true;
      input.close();
    };
    process.on('SIGINT', onSigint);
    try {
      await new Promise<void>((resolve) => {
        input.on('line', () => resolve());
        input.on('close', () => resolve());
      });
    } finally {
      process.off('SIGINT', onSigint);
    }
    if (interrupted) return;
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    return;
  }

  console.log(`Затем создай файл-маркер: ${marker} (Ctrl+C — поставить run на паузу).`);
  const start = Date.now();
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSigint);
  try {
    while (!existsSync(marker)) {
      if (interrupted) return;
      if (Date.now() - start > 10 * 60 * 1000) {
        throw new ResearchError('CAPTCHA_REQUIRED', 'CAPTCHA wait timeout (marker not created).');
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
  if (interrupted) return;
  rmSync(marker, { force: true });
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
}