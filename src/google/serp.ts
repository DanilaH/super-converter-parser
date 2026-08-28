import type { ResearchConfig } from '../config/config.js';
import { registrableDomain } from '../domains/normalize.js';

// Cache and resume identity depend on this value. Bump it whenever Google SERP
// parsing or derived SERP semantics (such as registrable-domain extraction) change.
export const GOOGLE_PARSER_VERSION = '1.3.0';

export const GOOGLE_SELECTORS = {
  organicResults: '#search a[href^="http"]:has(h3)',
  detectedLocation: 'span.AhYzQb',
  noResultsContainers: ['#search', '#topstuff', '#rso'],
};

export type RawOrganicLink = {
  href: string;
  title: string;
};

export type SerpResult = {
  keyword: string;
  keywordIdx?: number;
  position: number;
  title: string;
  url: string;
  hostname: string;
  registrableDomain: string;
  dr: number | null;
  // Outcome of the Ahrefs DR lookup for this row: null until enrichment runs,
  // 'ok' | 'not_found' | 'error' afterwards, and 'not_attempted' when DR
  // enrichment was intentionally skipped (e.g. AHREFS_API_KEY unset). Lets
  // completedDomains count every resolved domain, not only the ones with a
  // numeric DR, while still persisting observed domains when Ahrefs is off.
  drStatus: 'ok' | 'not_found' | 'error' | 'not_attempted' | null;
  // Error code captured from a failed Ahrefs lookup (null on success/skip), so
  // domain-level error provenance is not lost.
  drError?: string | null;
  resultType: 'organic';
};

// Browser-side code must stay a string: tsx/esbuild injects its __name helper
// into transpiled callbacks, which Playwright serializes without the helper
// and Chrome then fails on with "ReferenceError: __name is not defined".
// Selectors are interpolated from GOOGLE_SELECTORS at build time.
export const ORGANIC_EXTRACT_SCRIPT = String.raw`(() => {
  const links = Array.from(document.querySelectorAll(${JSON.stringify(GOOGLE_SELECTORS.organicResults)}));
  const seen = new Set();
  const out = [];
  for (const a of links) {
    const href = a.getAttribute('href') || '';
    if (!href || seen.has(href)) continue;
    const h3 = a.querySelector('h3');
    const title = h3 ? h3.innerText.replace(/\s+/g, ' ').trim() : '';
    if (!title) continue;
    seen.add(href);
    out.push({ href, title });
  }
  return out;
})()`;

// A genuine zero-result Google page shows "did not match any documents" inside
// Google's own containers. Extension-widget text must not be able to trigger
// this, so we never scan document.body as a whole.
export function isNoResultsPageText(text: string): boolean {
  return text.toLowerCase().indexOf('did not match any documents') !== -1;
}

// Self-contained browser copy of isNoResultsPageText scoped to Google's
// containers; keep both in sync.
export const GOOGLE_NO_RESULTS_SCRIPT = String.raw`(() => {
  const selectors = ${JSON.stringify(GOOGLE_SELECTORS.noResultsContainers)};
  for (let i = 0; i < selectors.length; i += 1) {
    const node = document.querySelector(selectors[i]);
    if (!node) continue;
    const text = (node.innerText || '').toLowerCase();
    if (text.indexOf('did not match any documents') !== -1) return true;
  }
  return false;
})()`;

export function buildOrganicResults(
  rawLinks: RawOrganicLink[],
  keyword: string,
  topN: number,
): SerpResult[] {
  const seen = new Set<string>();
  const results: SerpResult[] = [];

  for (const link of rawLinks) {
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (url.hostname === 'www.google.com' || url.hostname.endsWith('.google.com')) continue;
    if (seen.has(link.href)) continue;

    seen.add(link.href);
    results.push({
      keyword,
      position: results.length + 1,
      title: link.title,
      url: link.href,
      hostname: url.hostname,
      registrableDomain: registrableDomain(url.hostname) ?? '',
      dr: null,
      drStatus: null,
      resultType: 'organic',
    });

    if (results.length >= topN) break;
  }

  return results;
}

export const LOCATION_EXTRACT_SCRIPT = String.raw`(() => {
  const el = document.querySelector(${JSON.stringify(GOOGLE_SELECTORS.detectedLocation)});
  if (el) {
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return null;
})()`;

export const BODY_TEXT_SCRIPT = String.raw`(() => (document.body ? document.body.innerText : ''))()`;

const LOCATION_RE = /([A-Za-z][^\n]{2,120}?)\s*[—–-]\s*Based on your (?:places|past activity|search activity|location)/i;

export function detectGoogleLocationFromText(text: string): string | null {
  const match = text.match(LOCATION_RE);
  if (!match) return null;
  const location = match[1];
  if (!location) return null;
  const trimmed = location.trim();
  return trimmed || null;
}

export function geoMatchesMarket(market: string, detectedLocation: string): boolean {
  const target = market.trim();
  const detected = detectedLocation.trim();
  if (!target || !detected) return false;

  if (target.toUpperCase() === 'US' || target.toUpperCase() === 'USA') {
    return /united states|\busa\b|\bu\.?\s?\.?\s?u\.?s\.?\b/i.test(detected);
  }

  if (target.toUpperCase() === 'GB' || target.toUpperCase() === 'UK') {
    return /united kingdom|great britain|\bengland\b|\bscotland\b|\bwales\b|\b(uk|u\.k\.|gb|g\.b\.)\b/i.test(detected);
  }

  return detected.toLocaleLowerCase().includes(target.toLocaleLowerCase());
}

export function buildSearchUrl(
  config: ResearchConfig,
  query: string,
): string {
  const { googleHl, googleGl } = config.research;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(
    googleHl,
  )}&gl=${encodeURIComponent(googleGl)}`;
}
