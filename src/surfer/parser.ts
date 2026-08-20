import type { Page } from 'playwright-core';
import { ResearchError } from '../shared/errors.js';

export type SurferResult = {
  volume: number | null;
  cpc: number | null;
  rawText: string | null;
  widgetFound: boolean;
};

export function parseSurferNumber(value: string | undefined): number | null {
  if (!value) return null;

  const normalized = value.replace(/[$,\s]/g, '').toUpperCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return null;

  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;

  const multiplier =
    match[2] === 'K'
      ? 1_000
      : match[2] === 'M'
        ? 1_000_000
        : match[2] === 'B'
          ? 1_000_000_000
          : 1;
  return number * multiplier;
}

export async function readSurferResult(
  page: Page,
  widgetSelector: string,
  waitMs: number,
): Promise<SurferResult> {
  const widget = page.locator(widgetSelector).first();
  const deadline = Date.now() + waitMs;
  let lastRawText: string | null = null;
  let widgetFound = false;

  while (Date.now() <= deadline) {
    const rawText = (await widget.innerText().catch(() => '')).trim();
    if (rawText) {
      widgetFound = true;
      lastRawText = rawText;
    }

    const values = rawText.match(/\$?\s*\d[\d,.]*\s*[KMB]?/gi) ?? [];
    const volume = parseSurferNumber(values[0]);

    if (volume !== null) {
      return {
        volume,
        cpc: parseSurferNumber(values[1]),
        rawText,
        widgetFound: true,
      };
    }

    await page.waitForTimeout(500);
  }

  if (!widgetFound) {
    throw new ResearchError(
      'SURFER_NOT_DETECTED',
      `Keyword Surfer widget "${widgetSelector}" was not found on the page.`,
    );
  }

  throw new ResearchError(
    'SURFER_PARSE_ERROR',
    `Keyword Surfer widget was found but volume could not be parsed. Raw text: ${JSON.stringify(
      lastRawText,
    ).slice(0, 200)}`,
  );
}

export type SurferRelatedKeyword = {
  keyword: string;
  normalizedKeyword: string;
  // Overlap is the percentage shown in the widget, stored unitless as 0..100
  // (e.g. "50%" -> 50). This matches the displayed value and keeps the filters
  // and the whole contract unambiguous.
  overlap: number | null;
  volume: number | null;
};

// One structured row as extracted from the Surfer related-keywords table
// inside the assets.keywordsur.fr frame. Columns are Keyword | Overlap | Volume.
// We never parse the whole iframe as free text; each row is pulled from its
// own cells so the keyword name never inherits a stray "%" or volume digit.
export type SurferRelatedTableRow = {
  keyword: string;
  overlapText: string;
  volumeText: string;
};

// Overlap is displayed as a percentage in the widget (e.g. "50%"). We keep the
// unitless 0..100 number so the contract is unambiguous; a trailing "%" (or
// surrounding whitespace) is stripped. A non-numeric value yields null.
export function parseSurferOverlap(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/[%\s]/g, '').toUpperCase();
  if (normalized === '') return null;
  const match = /^(\d+(?:\.\d+)?)$/.exec(normalized);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

// Pure parser used by the browser-backed reader and by unit tests. Each row
// carries the keyword text plus its overlap/volume cells; we lift those into
// structured fields. The keyword text is taken verbatim (no number stripping),
// so a "%" is never left behind in the candidate name.
export function parseSurferRelatedRows(rows: SurferRelatedTableRow[]): SurferRelatedKeyword[] {
  const result: SurferRelatedKeyword[] = [];
  for (const row of rows) {
    const keyword = row.keyword.trim();
    if (!keyword) continue;
    result.push({
      keyword,
      normalizedKeyword: keyword.toLowerCase(),
      overlap: parseSurferOverlap(row.overlapText),
      volume: parseSurferNumber(row.volumeText),
    });
  }
  return result;
}

// Surfer renders the related-keywords widget inside an extension iframe hosted
// on assets.keywordsur.fr. We must read the table from that frame, not from the
// main document (the widget is absent from the top-level DOM).
const RELATED_FRAME_URL = /assets\.keywordsur\.fr/;

async function extractRelatedRowsFromFrame(
  frame: import('playwright-core').Frame,
  widgetSelector: string,
): Promise<SurferRelatedTableRow[] | null> {
  // Returns null when the widget is genuinely absent (broken selector/frame),
  // and an array (possibly empty) when the widget is present.
  const result = await frame.evaluate((widgetSel: string): SurferRelatedTableRow[] | null => {
    const widget = document.querySelector(widgetSel);
    if (!widget) return null;
    const rowEls = Array.from(widget.querySelectorAll('tr, li, [class*="row"]'));
    const out: SurferRelatedTableRow[] = [];
    for (const rowEl of rowEls) {
      const cells = Array.from(rowEl.querySelectorAll('td, span, div, a'));
      const texts = cells.map((c) => (c.textContent ?? '').trim()).filter(Boolean);
      // Keyword | Overlap | Volume: take the first three populated cells.
      if (texts.length >= 3) {
        out.push({ keyword: texts[0]!, overlapText: texts[1]!, volumeText: texts[2]! });
      }
    }
    return out;
  }, widgetSelector);
  return result;
}

export async function readSurferRelated(
  page: Page,
  widgetSelector: string,
  waitMs: number,
): Promise<SurferRelatedKeyword[]> {
  const deadline = Date.now() + waitMs;
  let frameSeen = false;
  let widgetSeen = false;

  while (Date.now() <= deadline) {
    const frame = page.frames().find((f) => RELATED_FRAME_URL.test(f.url()));
    if (frame) {
      frameSeen = true;
      const rows = await extractRelatedRowsFromFrame(frame, widgetSelector).catch(() => null);
      if (rows === null) {
        // Widget not present yet; keep waiting (it may still mount).
        await page.waitForTimeout(500);
        continue;
      }
      widgetSeen = true;
      if (rows.length > 0) return parseSurferRelatedRows(rows);
    }
    await page.waitForTimeout(500);
  }

  if (!frameSeen) {
    throw new ResearchError(
      'SURFER_NOT_DETECTED',
      `Surfer related-keywords frame (assets.keywordsur.fr) was not found on the page.`,
    );
  }
  if (!widgetSeen) {
    throw new ResearchError(
      'SURFER_RELATED_PARSE_ERROR',
      `Surfer related-keywords widget "${widgetSelector}" was not found inside the frame.`,
    );
  }
  // Frame and widget present, but genuinely no related keywords.
  return [];
}