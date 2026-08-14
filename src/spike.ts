import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { chromium, type Frame, type Page } from 'playwright-core';

const keyword = process.argv.slice(2).join(' ').trim() || 'compare lists';
const cdpUrl = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const waitMs = Number(process.env.SURFER_WAIT_MS ?? 12_000);
const debugDirectory = 'debug';

type FrameProbe = {
  name: string;
  url: string;
  title: string;
  candidateLines: string[];
  suspiciousElements: Array<{
    tag: string;
    id: string;
    className: string;
    text: string;
  }>;
  iframes: Array<{ src: string; title: string; id: string; className: string }>;
  shadowRoots: Array<{ host: string; text: string; html: string }>;
  bodyPreview: string;
};

type OrganicCandidate = {
  title: string;
  url: string;
};

async function waitForManualCaptcha(page: Page): Promise<void> {
  const captchaVisible = await page
    .locator('form[action*="sorry"], iframe[src*="recaptcha"], #captcha')
    .count();

  const blockedByText = await page
    .locator('body')
    .innerText()
    .then((text) => /unusual traffic|not a robot|captcha/i.test(text))
    .catch(() => false);

  if (!captchaVisible && !blockedByText) return;

  console.log('\nGoogle просит ручную проверку.');
  console.log('Реши CAPTCHA в окне Research Chrome, затем нажми Enter здесь.');

  const input = createInterface({ input: process.stdin, output: process.stdout });
  await input.question('');
  input.close();

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
}

async function probeFrame(frame: Frame): Promise<FrameProbe> {
  // Keep browser-side code as a string. When this callback was written as a
  // TypeScript function, tsx/esbuild injected its __name helper. Playwright
  // serialized the callback without that module-level helper, so it crashed in
  // Chrome before any DOM inspection could run.
  const script = String.raw`(() => {
    const marker = /keyword|surfer|volume|cpc|search volume|monthly searches/i;
    const clean = (value, limit = 500) =>
      (value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

    const bodyText = document.body?.innerText ?? '';
    const candidateLines = bodyText
      .split('\n')
      .map((line) => clean(line))
      .filter((line) => line.length > 0 && line.length < 300 && marker.test(line))
      .slice(0, 100);

    const suspiciousElements = Array.from(document.querySelectorAll('*'))
      .map((element) => {
        const signature = [
          element.tagName,
          element.id,
          element.className,
          Array.from(element.attributes)
            .map((attribute) => attribute.name + '=' + attribute.value)
            .join(' '),
          element.innerText,
        ].join(' ');

        if (!marker.test(signature)) return null;

        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          className:
            typeof element.className === 'string' ? clean(element.className, 200) : '',
          text: clean(element.innerText, 300),
        };
      })
      .filter((value) => value !== null)
      .slice(0, 150);

    const iframes = Array.from(document.querySelectorAll('iframe')).map((iframe) => ({
      src: iframe.src,
      title: iframe.title,
      id: iframe.id,
      className: typeof iframe.className === 'string' ? iframe.className : '',
    }));

    const shadowRoots = Array.from(document.querySelectorAll('*'))
      .flatMap((element) => {
        const root = element.shadowRoot;
        if (!root) return [];

        return [{
          host: [
            element.tagName.toLowerCase(),
            element.id ? '#' + element.id : '',
            typeof element.className === 'string' && element.className
              ? '.' + element.className.split(/\s+/).join('.')
              : '',
          ].join(''),
          text: clean(root.textContent, 1000),
          html: clean(root.innerHTML, 2000),
        }];
      })
      .slice(0, 100);

    return {
      title: document.title,
      candidateLines,
      suspiciousElements,
      iframes,
      shadowRoots,
      bodyPreview: clean(bodyText, 3000),
    };
  })()`;

  const data = (await frame.evaluate(script)) as Omit<FrameProbe, 'name' | 'url'>;

  return {
    name: frame.name(),
    url: frame.url(),
    ...data,
  };
}

async function readOrganicCandidates(page: Page): Promise<OrganicCandidate[]> {
  const links = page.locator('#search a:has(h3)');
  const count = Math.min(await links.count(), 30);
  const results: OrganicCandidate[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    const title = (await link.locator('h3').first().innerText().catch(() => '')).trim();
    const url = (await link.getAttribute('href')) ?? '';

    if (!title || !url.startsWith('http') || seen.has(url)) continue;

    seen.add(url);
    results.push({ title, url });
  }

  return results;
}

async function main(): Promise<void> {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error('SURFER_WAIT_MS должен быть неотрицательным числом.');
  }

  await mkdir(debugDirectory, { recursive: true });

  console.log(`Подключение к Research Chrome: ${cdpUrl}`);

  const browser = await chromium.connectOverCDP(cdpUrl).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Не удалось подключиться к Chrome. Сначала запусти его с remote debugging.\n${message}`,
    );
  });

  const context = browser.contexts()[0];
  if (!context) throw new Error('Chrome подключён, но browser context не найден.');

  const page = await context.newPage();
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&hl=en&gl=us`;

  console.log(`Открываю Google: ${keyword}`);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForManualCaptcha(page);

  console.log(`Жду расширение: ${waitMs} ms`);
  await page.waitForTimeout(waitMs);

  await page.screenshot({
    path: `${debugDirectory}/google-serp.png`,
    fullPage: true,
  });
  await writeFile(`${debugDirectory}/google-serp.html`, await page.content(), 'utf8');

  const frames: FrameProbe[] = [];
  for (const frame of page.frames()) {
    try {
      frames.push(await probeFrame(frame));
    } catch (error) {
      frames.push({
        name: frame.name(),
        url: frame.url(),
        title: '',
        candidateLines: [],
        suspiciousElements: [],
        iframes: [],
        shadowRoots: [],
        bodyPreview: `FRAME_PROBE_ERROR: ${String(error)}`,
      });
    }
  }

  const organicCandidates = await readOrganicCandidates(page);
  const report = {
    keyword,
    timestamp: new Date().toISOString(),
    cdpUrl,
    pageUrl: page.url(),
    frameCount: frames.length,
    frames,
    organicCandidates,
  };

  await writeFile(
    `${debugDirectory}/probe-report.json`,
    JSON.stringify(report, null, 2),
    'utf8',
  );

  console.log('\nКандидатные строки Keyword Surfer:');
  const candidateLines = frames.flatMap((frame) =>
    frame.candidateLines.map((line) => `[${frame.url}] ${line}`),
  );
  console.log(candidateLines.length ? candidateLines.join('\n') : 'Ничего не найдено.');

  console.log(`\nIframe: ${frames.reduce((sum, frame) => sum + frame.iframes.length, 0)}`);
  console.log(
    `Open shadow roots: ${frames.reduce((sum, frame) => sum + frame.shadowRoots.length, 0)}`,
  );

  console.log('\nКандидаты органической выдачи:');
  console.table(organicCandidates.slice(0, 10));

  console.log('\nДиагностика сохранена в debug/.');
  console.log('Окно Research Chrome оставлено открытым.');
  await page.close();
}

main().catch((error: unknown) => {
  console.error('\nProbe завершился с ошибкой:');
  console.error(error);
  process.exitCode = 1;
});
