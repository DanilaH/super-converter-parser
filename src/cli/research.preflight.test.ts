import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page, Locator } from 'playwright-core';
import { runCli, EXIT_PAUSED, EXIT_OK } from './research.js';
import { preflightGoogleAndSurfer } from '../browser/preflight.js';
import { collectKeyword } from '../browser/collect.js';
import type { CollectionResult } from '../browser/collect.js';
import type { ResearchConfig } from '../config/config.js';
import type { KeywordRecord } from '../runs/run.js';
import type { CancellationSignal } from '../browser/captcha.js';
import { SURFER_MARKERS } from '../surfer/selectors.js';
import { RunStore, isTerminalKeywordStatus } from '../db/store.js';

function fakePage(captcha: boolean): Page {
  const isCaptcha = (sel: string) => sel.toLowerCase().includes('captcha');
  const bodyText = captcha ? 'unusual traffic' : 'normal search results';
  const evaluate = async (script: string): Promise<unknown> => {
    if (script.includes('return out')) {
      return [{ href: 'https://c.example', title: 'C Example' }];
    }
    if (script.includes(SURFER_MARKERS.cssMarker)) return true;
    if (script.includes('GEO_EXTRACT_SCRIPT')) return null;
    return undefined;
  };
  const textFor = (sel: string) => {
    if (sel === 'body') return bodyText;
    if (sel.toLowerCase().includes('surfer')) return '$49,500';
    return '';
  };
  return {
    async goto(_url: string) {},
    url: () => 'https://www.google.com/search?q=preflight+probe&gl=us&hl=en',
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
      const count = captcha && isCaptcha(sel) ? 1 : 0;
      return {
        count: async () => count,
        first: () => ({ innerText: async () => textFor(sel) }),
        innerText: async () => textFor(sel),
      } as unknown as Locator;
    },
    evaluate,
  } as unknown as Page;
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

test('Ctrl+C during preflight leaves a resumable run; resume continues past preflight', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'research-preflight-resume-'));
  mkdirSync(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\n', 'utf8');
  rmSync(join(directory, 'runs'), { recursive: true, force: true });

  const deps = (captcha: boolean) => ({
    connect: async () => fakeBrowser(fakePage(captcha)),
    preflight: async (ctx: BrowserContext, cfg: ResearchConfig, signal: CancellationSignal) =>
      preflightGoogleAndSurfer(ctx, cfg, signal),
    collect: async (
      ctx: BrowserContext,
      cfg: ResearchConfig,
      record: KeywordRecord,
      debugRoot: string,
      signal: CancellationSignal,
    ): Promise<CollectionResult> => collectKeyword(ctx, cfg, record, debugRoot, signal),
  });

  const previousCwd = process.cwd();
  process.chdir(directory);
  const marker = join(directory, 'captcha-done.txt');
  rmSync(marker, { force: true });
  const originalMarker = process.env.CAPTCHA_DONE_MARKER;
  process.env.CAPTCHA_DONE_MARKER = marker;
  try {
    // Phase 1: interrupt during preflight (a CAPTCHA is presented on the probe page).
    const run1 = runCli(['--seeds', 'input/seeds.csv'], deps(true), {
      AHREFS_API_KEY: undefined,
      EXPANSION_ENABLED: 'false',
    } as unknown as NodeJS.ProcessEnv);
    const timer = setTimeout(() => {
      process.emit('SIGINT');
    }, 400);
    const code1 = await run1;
    clearTimeout(timer);

    assert.equal(code1, EXIT_PAUSED, 'run must exit paused (130) after Ctrl+C during preflight');

    const runId = (await readdir(join(directory, 'runs')))[0] as string;

    // The run must be fully initialized and resumable, not an under-initialized
    // stub: the run record and its staged keyword exist on disk.
    const store = RunStore.open(join(directory, 'runs', runId, 'run.sqlite'));
    const run = store.loadRun(runId);
    assert.ok(run, 'run record must exist after a preflight cancellation');
    assert.equal(run!.state, 'paused', 'run state must be paused (resumable)');
    const stored = store.loadKeywords(runId);
    assert.equal(stored.length, 1, 'the seed keyword must be staged in the store');
    assert.equal(stored[0]!.status, 'pending', 'staged keyword must stay pending, not terminal');
    assert.equal(isTerminalKeywordStatus(stored[0]!.status), false, 'staged keyword must not be terminal');
    store.close();

    const status1 = JSON.parse(
      await readFile(join(directory, 'runs', runId, 'status.json'), 'utf8'),
    ) as { status: string };
    assert.equal(status1.status, 'paused', 'persisted run status must be paused');

    // Phase 2: resume; preflight re-runs (no CAPTCHA this time) and collection completes.
    const code2 = await runCli(['--resume', runId], deps(false), {
      AHREFS_API_KEY: undefined,
      EXPANSION_ENABLED: 'false',
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(code2, EXIT_OK, 'resumed run must complete past preflight');

    const store2 = RunStore.open(join(directory, 'runs', runId, 'run.sqlite'));
    const resumed = store2.loadKeywords(runId);
    assert.equal(resumed.length, 1, 'keyword count is unchanged after resume');
    assert.equal(isTerminalKeywordStatus(resumed[0]!.status), true, 'keyword must be terminal after real collection');
    assert.equal(resumed[0]!.surfer?.volume, 49500, 'real collection must have parsed the Surfer volume');
    assert.equal(existsSync(marker), false, 'no marker was created (cancel, not solve)');
    store2.close();
  } finally {
    if (originalMarker === undefined) delete process.env.CAPTCHA_DONE_MARKER;
    else process.env.CAPTCHA_DONE_MARKER = originalMarker;
    process.chdir(previousCwd);
  }
});
