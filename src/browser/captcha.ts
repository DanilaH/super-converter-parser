import { createInterface } from 'node:readline/promises';
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
  console.log('Реши CAPTCHA в окне Research Chrome, затем нажми Enter здесь.');

  const input = createInterface({ input: process.stdin, output: process.stdout });
  await input.question('');
  input.close();

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
}