// Google "related searches" (Searches related to …) suggestions.
// Source = google_related_search. Factual query-language only; no volume/CPC.

export const GOOGLE_RELATED_SEARCH_PARSER_VERSION = '1.0.0';

// Browser-side extractor. Google renders related searches as a card of links
// whose text is the suggestion. We collect every anchor text inside the related
// searches module and de-duplicate. The selector is a best-effort contraction of
// the observed "Related searches" container; the pure parse step below is what
// unit tests exercise, so this script only feeds it raw candidate strings.
export const RELATED_SEARCH_EXTRACT_SCRIPT = String.raw`(() => {
  const out = [];
  const headings = Array.from(document.querySelectorAll('h3, div, span'));
  for (const h of headings) {
    const text = (h.innerText || '').trim().toLowerCase();
    if (text !== 'related searches' && text !== 'searches related to') continue;
    let node = h.parentElement;
    while (node && !node.querySelector('a')) node = node.parentElement;
    if (!node) continue;
    const links = Array.from(node.querySelectorAll('a'));
    for (const a of links) {
      const label = (a.innerText || '').replace(/\s+/g, ' ').trim();
      if (label) out.push(label);
    }
  }
  return out;
})()`;

// Normalizes and de-duplicates raw related-search strings. Keeps order of first
// appearance; trims and collapses whitespace; case-insensitive dedup so the same
// suggestion spelled differently is not double counted.
export function parseGoogleRelatedSearch(rawTexts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawTexts) {
    const value = raw.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
