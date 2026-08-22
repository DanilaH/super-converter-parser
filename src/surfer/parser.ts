import type { Page } from 'playwright-core';
import { ResearchError } from '../shared/errors.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';

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

// One structured row as extracted from the Surfer related-keywords table in
// the main document. Columns are Keyword | Overlap | Volume.
// We never parse the whole widget as free text; each row is pulled from its
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
      normalizedKeyword: normalizeKeyword(keyword),
      overlap: parseSurferOverlap(row.overlapText),
      volume: parseSurferNumber(row.volumeText),
    });
  }
  return result;
}

// Reads the related-keywords table that Keyword Surfer renders in the main
// Google DOM inside the keyword-surfer-sidebar element. Each row's direct <td>
// cells are [checkbox, keyword, overlap, volume]; we take the keyword/overlap/
// volume cells (indices 1/2/3) and read only the direct cell text so nested
// <a>/<span>/<div> text is not duplicated.
type RelatedDomSnapshot =
  | { state: 'widget_missing' | 'table_missing' | 'empty' }
  | { state: 'malformed'; cellCounts: number[] }
  | { state: 'rows'; rows: SurferRelatedTableRow[] };

async function extractRelatedRows(page: Page, widgetSelector: string): Promise<RelatedDomSnapshot> {
  return page.evaluate((widgetSel: string): RelatedDomSnapshot => {
    const widget = document.querySelector(widgetSel);
    if (!widget) return { state: 'widget_missing' };
    const table = widget.querySelector('table');
    if (!table) return { state: 'table_missing' };
    const tbody = table.querySelector('tbody') ?? table;
    const trs = Array.from(tbody.querySelectorAll(':scope > tr'));
    if (trs.length === 0) return { state: 'empty' };
    const out: SurferRelatedTableRow[] = [];
    const malformedCellCounts: number[] = [];
    for (const tr of trs) {
      // Only direct child <td> cells; nested elements are not traversed, so
      // their text is not duplicated.
      const tds = Array.from(tr.querySelectorAll(':scope > td'));
      if (tds.length !== 4) {
        malformedCellCounts.push(tds.length);
        continue;
      }
      out.push({
        keyword: (tds[1]?.textContent ?? '').trim(),
        overlapText: (tds[2]?.textContent ?? '').trim(),
        volumeText: (tds[3]?.textContent ?? '').trim(),
      });
    }
    if (malformedCellCounts.length > 0) {
      return { state: 'malformed', cellCounts: malformedCellCounts };
    }
    return { state: 'rows', rows: out };
  }, widgetSelector);
}

export async function readSurferRelated(
  page: Page,
  widgetSelector: string,
  waitMs: number,
): Promise<SurferRelatedKeyword[]> {
  const deadline = Date.now() + waitMs;
  let lastSnapshot: RelatedDomSnapshot = { state: 'widget_missing' };
  // Fast-fail for a genuinely missing widget: if it hasn't appeared after the
  // first two polls (~1s), it is not going to mount lazily. This avoids a full
  // waitMs wait (60s default) in environments where the related sidebar does not
  // render (e.g. copied Surfer profiles), while still giving a legitimately
  // lazy widget ~1s to appear. A missing widget returns an empty list (the
  // keyword still completes with its main volume/SERP data); only a present-but
  // broken widget throws.
  let widgetMissingPolls = 0;
  const WIDGET_MISSING_FAST_FAIL_POLLS = 2;

  while (Date.now() <= deadline) {
    const snapshot = await extractRelatedRows(page, widgetSelector).catch(() => undefined);
    if (snapshot !== undefined) lastSnapshot = snapshot;
    if (snapshot?.state === 'rows') return parseSurferRelatedRows(snapshot.rows);
    if (snapshot?.state === 'malformed') {
      throw new ResearchError(
        'SURFER_RELATED_PARSE_ERROR',
        `Surfer related-keywords table contains malformed rows; expected exactly 4 direct <td> cells, got ${snapshot.cellCounts.join(', ')}.`,
      );
    }
    if (snapshot?.state === 'widget_missing' || lastSnapshot.state === 'widget_missing') {
      widgetMissingPolls += 1;
      if (widgetMissingPolls >= WIDGET_MISSING_FAST_FAIL_POLLS) return [];
    }
    await page.waitForTimeout(500);
  }

  if (lastSnapshot.state === 'empty') return [];
  if (lastSnapshot.state === 'widget_missing') {
    return [];
  }
  throw new ResearchError(
    'SURFER_RELATED_PARSE_ERROR',
    `Surfer related-keywords widget "${widgetSelector}" was found, but its table was not found.`,
  );
}
