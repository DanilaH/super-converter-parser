import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page, Locator } from 'playwright-core';
import { runCli, EXIT_PAUSED, EXIT_OK } from './research.js';
import { collectKeyword } from '../browser/collect.js';
import type { CollectionResult, RelatedCollectionResult } from '../browser/collect.js';
import type { ResearchConfig } from '../config/config.js';
import type { KeywordRecord } from '../runs/run.js';
import type { CancellationSignal } from '../browser/captcha.js';
import { RunStore, isTerminalKeywordStatus } from '../db/store.js';

// Minimal related collector for tests that exercise CAPTCHA/resume flows:
// returns empty without touching the browser, since these tests care about
// pause/resume semantics, not related-keyword parsing.
const emptyRelated = async (): Promise<RelatedCollectionResult> => ({
  related: { status: 'empty', error: null, rows: [] },
  debugArtifactPath: null,
});

function fakePage(captcha: boolean): Page {
  const isCaptcha = (sel: string) => sel.toLowerCase().includes('captcha');
  const isSurfer = (sel: string) => sel.toLowerCase().includes('surfer');
  const bodyText = captcha ? 'unusual traffic' : 'normal search results';
  const evaluate = async (script: string): Promise<unknown> => {
        if (script.includes('return out')) {
          return [{ href: 'https://c.example', title: 'C Example' }];
        }
    if (script.includes('GEO_EXTRACT_SCRIPT')) return null;
    return undefined;
  };
  const textFor = (sel: string) => {
    if (sel === 'body') return bodyText;
    if (isSurfer(sel)) return '$49,500';
    return '';
  };
  return {
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
      const count = captcha && isCaptcha(sel) ? 1 : isSurfer(sel) ? 1 : 0;
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

test('Ctrl+C during CAPTCHA wait pauses without committing the keyword; resume collects it for real', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'research-captcha-resume-'));
  mkdirSync(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\n', 'utf8');
  rmSync(join(directory, 'runs'), { recursive: true, force: true });

  delete process.env.CAPTCHA_DONE_MARKER;

  const depsCaptcha = {
    connect: async () => fakeBrowser(fakePage(true)),
    preflight: async () => undefined,
    collect: async (
      ctx: BrowserContext,
      cfg: ResearchConfig,
      record: KeywordRecord,
      debugRoot: string,
      signal: CancellationSignal,
    ): Promise<CollectionResult> => collectKeyword(ctx, cfg, record, debugRoot, signal),
    collectRelated: emptyRelated,
  };
  const depsClean = {
    connect: async () => fakeBrowser(fakePage(false)),
    preflight: async () => undefined,
    collect: async (
      ctx: BrowserContext,
      cfg: ResearchConfig,
      record: KeywordRecord,
      debugRoot: string,
      signal: CancellationSignal,
    ): Promise<CollectionResult> => collectKeyword(ctx, cfg, record, debugRoot, signal),
    collectRelated: emptyRelated,
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  const marker = join(directory, 'captcha-done.txt');
  rmSync(marker, { force: true });
  const originalMarker = process.env.CAPTCHA_DONE_MARKER;
  process.env.CAPTCHA_DONE_MARKER = marker;
  try {
    // Phase 1: interrupt while the active keyword is stuck on the CAPTCHA wait.
    const run1 = runCli(['--seeds', 'input/seeds.csv'], depsCaptcha, {
      AHREFS_API_KEY: undefined,
      EXPANSION_ENABLED: 'false',
    } as unknown as NodeJS.ProcessEnv);
    const timer = setTimeout(() => {
      process.emit('SIGINT');
    }, 400);
    const code1 = await run1;
    clearTimeout(timer);

    assert.equal(code1, EXIT_PAUSED, 'run must exit paused (130) after Ctrl+C during CAPTCHA wait');

    const runId = (await readdir(join(directory, 'runs')))[0] as string;
    const status1 = JSON.parse(
      await readFile(join(directory, 'runs', runId, 'status.json'), 'utf8'),
    ) as { status: string };
    assert.equal(status1.status, 'paused', 'persisted run status must be paused');

    // The active keyword must NOT be committed as a terminal result: it stays
    // resumable so a later --resume re-collects it for real.
    const store = RunStore.open(join(directory, 'runs', runId, 'run.sqlite'));
    const stored = store.loadKeywords(runId);
    assert.equal(stored.length, 1, 'exactly one keyword was queued');
    assert.equal(stored[0]!.status, 'running', 'interrupted keyword must remain running (resumable), not terminal');
    assert.equal(isTerminalKeywordStatus(stored[0]!.status), false, 'interrupted keyword must not be terminal');
    assert.equal(existsSync(marker), false, 'no marker was created (cancel, not solve)');
    store.close();

    // Phase 2: resume; the keyword is re-collected for real (no CAPTCHA this time).
    const code2 = await runCli(['--resume', runId], depsClean, {
      AHREFS_API_KEY: undefined,
      EXPANSION_ENABLED: 'false',
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(code2, EXIT_OK, 'resumed run must complete');

    const store2 = RunStore.open(join(directory, 'runs', runId, 'run.sqlite'));
    const resumed = store2.loadKeywords(runId);
    assert.equal(resumed.length, 1, 'keyword count is unchanged after resume');
    assert.equal(isTerminalKeywordStatus(resumed[0]!.status), true, 'keyword must be terminal after real collection');
    assert.equal(resumed[0]!.surfer?.volume, 49500, 'real collection must have parsed the Surfer volume');
    store2.close();

    const serpCsv = await readFile(join(directory, 'runs', runId, 'serp.csv'), 'utf8');
    assert.ok(serpCsv.includes('c.example'), 'resumed run must contain the real organic SERP rows');
  } finally {
    if (originalMarker === undefined) delete process.env.CAPTCHA_DONE_MARKER;
    else process.env.CAPTCHA_DONE_MARKER = originalMarker;
    process.chdir(previousCwd);
  }
});

test('second Ctrl+C force-quits (single SIGINT handler owns pause/quit)', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'research-forcequit-'));
  mkdirSync(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\n', 'utf8');
  rmSync(join(directory, 'runs'), { recursive: true, force: true });

  const depsCaptcha = {
    connect: async () => fakeBrowser(fakePage(true)),
    preflight: async () => undefined,
    collect: async (
      ctx: BrowserContext,
      cfg: ResearchConfig,
      record: KeywordRecord,
      debugRoot: string,
      signal: CancellationSignal,
    ): Promise<CollectionResult> => collectKeyword(ctx, cfg, record, debugRoot, signal),
    collectRelated: emptyRelated,
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  const marker = join(directory, 'captcha-done.txt');
  rmSync(marker, { force: true });
  const originalMarker = process.env.CAPTCHA_DONE_MARKER;
  process.env.CAPTCHA_DONE_MARKER = marker;

  // The captcha helper must not have installed its own SIGINT listener, so the
  // CLI's single handler owns both pause (first Ctrl+C) and force-quit (second).
  // The CLI force-quits by removing its handler and re-delivering a real SIGINT
  // (process.kill(pid, 'SIGINT')). Spy on process.kill to prove that path runs.
  const killCalls: Array<string | undefined> = [];
  const realKill = process.kill;
  (process as { kill: (pid: number, signal: string) => void }).kill = ((
    _pid: number,
    signal: string,
  ) => {
    killCalls.push(signal);
  }) as (pid: number, signal: string) => void;

  try {
    const run = runCli(['--seeds', 'input/seeds.csv'], depsCaptcha, {
      AHREFS_API_KEY: undefined,
      EXPANSION_ENABLED: 'false',
    } as unknown as NodeJS.ProcessEnv);
    const t1 = setTimeout(() => process.emit('SIGINT'), 400);
    const t2 = setTimeout(() => process.emit('SIGINT'), 600);
    const code = await run;
    clearTimeout(t1);
    clearTimeout(t2);

    // First Ctrl+C paused the run; the second Ctrl+C must reach the force-quit
    // path (the CLI re-delivers a real SIGINT after dropping its own handler).
    assert.ok(killCalls.includes('SIGINT'), 'second Ctrl+C must invoke force-quit (process.kill SIGINT)');
    assert.equal(code, EXIT_PAUSED, 'the run must report the first Ctrl+C as a graceful pause');
  } finally {
    process.kill = realKill;
    if (originalMarker === undefined) delete process.env.CAPTCHA_DONE_MARKER;
    else process.env.CAPTCHA_DONE_MARKER = originalMarker;
    process.chdir(previousCwd);
  }
});
