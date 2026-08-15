import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { ResearchError } from '../shared/errors.js';

export async function connectResearchChrome(cdpUrl: string): Promise<Browser> {
  try {
    return await chromium.connectOverCDP(cdpUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResearchError(
      'BROWSER_CONNECTION_ERROR',
      `Cannot connect to Research Chrome at ${cdpUrl}. Start it with --remote-debugging-port first.\n${message}`,
      { cause: error },
    );
  }
}

export function getPrimaryContext(browser: Browser): BrowserContext {
  const context = browser.contexts()[0];
  if (!context) {
    throw new ResearchError(
      'BROWSER_CONNECTION_ERROR',
      'Chrome is connected but no browser context was found.',
    );
  }
  return context;
}