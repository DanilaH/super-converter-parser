import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright-core';
import type { ResearchConfig } from '../config/config.js';
import { GOOGLE_PARSER_VERSION, GOOGLE_SELECTORS } from '../google/serp.js';
import { SURFER_PARSER_VERSION, SURFER_MARKERS } from '../surfer/selectors.js';
import type { ResearchErrorCode } from '../shared/errors.js';

export type ParserFailureContext = {
  keyword: string;
  url: string;
  timestamp: string;
  parserVersions: {
    surfer: string;
    google: string;
  };
  selectors: {
    surferMainWidget: string;
    surferCssMarker: string;
    organicResults: string;
    detectedLocation: string;
  };
  errorCode: ResearchErrorCode;
  errorMessage: string;
};

export async function saveParserFailureArtifacts(
  page: Page,
  config: ResearchConfig,
  debugRoot: string,
  keywordSlugName: string,
  context: ParserFailureContext,
): Promise<string> {
  const directory = `${debugRoot}/${keywordSlugName}`;
  await mkdir(directory, { recursive: true });

  await page.screenshot({ path: `${directory}/page.png`, fullPage: true });
  await writeFile(`${directory}/page.html`, await page.content(), 'utf8');
  await writeFile(
    `${directory}/parser-context.json`,
    `${JSON.stringify(context, null, 2)}\n`,
    'utf8',
  );

  return directory;
}

export function buildParserFailureContext(
  keyword: string,
  pageUrl: string,
  config: ResearchConfig,
  errorCode: ResearchErrorCode,
  errorMessage: string,
): ParserFailureContext {
  return {
    keyword,
    url: pageUrl,
    timestamp: new Date().toISOString(),
    parserVersions: {
      surfer: SURFER_PARSER_VERSION,
      google: GOOGLE_PARSER_VERSION,
    },
    selectors: {
      surferMainWidget: config.browser.surferWidgetSelector,
      surferCssMarker: SURFER_MARKERS.cssMarker,
      organicResults: GOOGLE_SELECTORS.organicResults,
      detectedLocation: GOOGLE_SELECTORS.detectedLocation,
    },
    errorCode,
    errorMessage,
  };
}

export function isParserErrorCode(code: ResearchErrorCode): boolean {
  return code === 'SURFER_NOT_DETECTED' || code === 'SURFER_PARSE_ERROR' || code === 'GOOGLE_SERP_PARSE_ERROR';
}