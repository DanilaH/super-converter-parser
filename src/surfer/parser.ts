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
  overlap: number | null;
  volume: number | null;
};

// Pure parser used by the browser-backed reader and by unit tests. The related
// keyword widget renders one candidate per line; each line carries the keyword
// text plus optional numeric volume/overlap tokens. We keep the keyword text
// and lift any detected numbers into structured fields.
export function parseSurferRelatedText(widgetText: string): SurferRelatedKeyword[] {
  const lines = widgetText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const result: SurferRelatedKeyword[] = [];
  for (const line of lines) {
    const numbers = line.match(/\d[\d,.]*\s*[KMB]?/gi) ?? [];
    const volume = parseSurferNumber(numbers[0]);
    const overlap = parseSurferNumber(numbers[1]);

    const keyword = line
      .replace(/\d[\d,.]*\s*[KMB]?/gi, '')
      .replace(/[|•·\-–—]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!keyword) continue;

    result.push({
      keyword,
      normalizedKeyword: keyword.toLowerCase(),
      volume,
      overlap,
    });
  }

  return result;
}

export async function readSurferRelated(
  page: Page,
  widgetSelector: string,
  waitMs: number,
): Promise<SurferRelatedKeyword[]> {
  const widget = page.locator(widgetSelector).first();
  const deadline = Date.now() + waitMs;

  while (Date.now() <= deadline) {
    const text = (await widget.innerText().catch(() => '')).trim();
    if (text) {
      const parsed = parseSurferRelatedText(text);
      if (parsed.length > 0) return parsed;
    }

    await page.waitForTimeout(500);
  }

  return [];
}