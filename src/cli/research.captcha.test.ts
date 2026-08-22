import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page, Locator } from 'playwright-core';
import { runCli, EXIT_PAUSED } from './research.js';
import { collectKeyword } from '../browser/collect.js';
import type { CollectionResult } from '../browser/collect.js';
import type { ResearchConfig } from '../config/config.js';
import type { KeywordRecord } from '../runs/run.js';

function fakePage(): Page {
  const isCaptcha = (sel: string) => sel.toLowerCase().includes('captcha');
  const isSurfer = (sel: string) => sel.toLowerCase().includes('surfer');
  const evaluate = async (script: string): Promise<unknown> => {
    if (script.includes('ORGANIC_EXTRACT_SCRIPT')) {
      return {
        rows: [
          {
            position: 1,
            title: 'C',
            url: 'https://c.example',
            displayUrl: 'c.example',
            snippet: 'snip',
            googleLocation: null,
          },
        ],
      };
    }
    if (script.includes('GEO_EXTRACT_SCRIPT')) return null;
    return undefined;
  };
  const textFor = (sel: string) => (isSurfer(sel) ? '$49,500' : 'unusual traffic');
  const page = {
    async goto(_url: string) {},
    url: () => 'https://www.google.com/search?q=k1&gl=us&hl=en',
    async screenshot(_opts?: unknown) {
      return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
        'base64',
      );
    },
    async content() {
      return '<html><body>C</body></html>';
    },
    async waitForTimeout(_ms: number) {},
    async waitForLoadState(_state?: string) {},
    async close() {},
    locator: (sel: string): Locator => {
      const count = isCaptcha(sel) || isSurfer(sel) ? 1 : 0;
      return {
        count: async () => count,
        first: () => ({ innerText: async () => textFor(sel) }),
        innerText: async () => textFor(sel),
      } as unknown as Locator;
    },
    evaluate,
  } as unknown as Page;
  return page;
}

function fakeBrowser(page: Page): Browser {
  const context = {
    async newPage() {
      return page;
    },
    async close() {},
  } as unknown as BrowserContext;
  return {
    contexts: () => [context],
    async close() {},
  } as unknown as Browser;
}

test('capcha marker-wait is interruptible by the first Ctrl+C -> run pauses with 130', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'research-captcha-int-'));
  mkdirSync(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\nk2\n', 'utf8');
  rmSync(join(directory, 'runs'), { recursive: true, force: true });

  // Ensure no stray marker exists anywhere the watcher could pick up.
  const originalMarker = process.env.CAPTCHA_DONE_MARKER;
  delete process.env.CAPTCHA_DONE_MARKER;

  const page = fakePage();
  const deps = {
    connect: async () => fakeBrowser(page),
    preflight: async () => undefined,
    collect: async (
      ctx: BrowserContext,
      cfg: ResearchConfig,
      record: KeywordRecord,
      debugRoot: string,
    ): Promise<CollectionResult> => collectKeyword(ctx, cfg, record, debugRoot),
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const run = runCli(['--seeds', 'input/seeds.csv'], deps, {
      AHREFS_API_KEY: undefined,
      EXPANSION_ENABLED: 'false',
    } as unknown as NodeJS.ProcessEnv);

    // Fire the first Ctrl+C while the keyword is stuck in the captcha wait.
    const timer = setTimeout(() => {
      process.emit('SIGINT');
    }, 400);
    const code = await run;
    clearTimeout(timer);

    assert.equal(code, EXIT_PAUSED, 'run must exit paused (130) after the first Ctrl+C');

    const runId = (await readdir(join(directory, 'runs')))[0] as string;
    const status = JSON.parse(
      await readFile(join(directory, 'runs', runId, 'status.json'), 'utf8'),
    ) as { status: string };
    assert.equal(status.status, 'paused', 'persisted run status must be paused');
    assert.equal(existsSync('C:\\tmp\\captcha-done.txt'), false, 'no marker was created');
  } finally {
    process.chdir(previousCwd);
    if (originalMarker === undefined) delete process.env.CAPTCHA_DONE_MARKER;
    else process.env.CAPTCHA_DONE_MARKER = originalMarker;
  }
});
