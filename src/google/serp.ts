import type { ResearchConfig } from '../config/config.js';

export const GOOGLE_PARSER_VERSION = '1.1.0';

export const GOOGLE_SELECTORS = {
  organicResults: '#search a[href^="http"]:has(h3)',
  detectedLocation: 'span.AhYzQb',
};

export type RawOrganicLink = {
  href: string;
  title: string;
};

export type SerpResult = {
  keyword: string;
  position: number;
  title: string;
  url: string;
  hostname: string;
  resultType: 'organic';
};

// Browser-side code must stay a string: tsx/esbuild injects its __name helper
// into transpiled callbacks, which Playwright serializes without the helper
// and Chrome then fails on with "ReferenceError: __name is not defined".
export const ORGANIC_EXTRACT_SCRIPT = String.raw`(() => {
  const links = Array.from(document.querySelectorAll('#search a[href^="http"]:has(h3)'));
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

export function isNoResultsPageText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.indexOf('did not match any documents') !== -1 ||
    lower.indexOf('no results found') !== -1
  );
}

// Self-contained browser copy of isNoResultsPageText; keep both in sync.
export const GOOGLE_NO_RESULTS_SCRIPT = String.raw`(() => {
  const text = ((document.body && document.body.innerText) || '').toLowerCase();
  return text.indexOf('did not match any documents') !== -1 || text.indexOf('no results found') !== -1;
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
      resultType: 'organic',
    });

    if (results.length >= topN) break;
  }

  return results;
}

export const LOCATION_EXTRACT_SCRIPT = String.raw`(() => {
  const el = document.querySelector('span.AhYzQb');
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

export const PREFLIGHT_SURFER_MARKER_SCRIPT = String.raw`(() => {
  const root = document.documentElement || document;
  return root.innerHTML.indexOf('.keyword-surfer') !== -1;
})()`;