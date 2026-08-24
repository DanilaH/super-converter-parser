// Google "People Also Ask" (PAA) suggestions. Source = google_paa.
// Only the QUESTION TEXT is collected. We never click a PAA question and never
// collect its answer; the issue explicitly forbids expanding into PAA answers.

export const GOOGLE_PAA_PARSER_VERSION = '1.0.0';

// Browser-side extractor: collect every PAA question text. The PAA module renders
// each question inside a button/div whose text is the question; we avoid the
// expanded answer containers by reading only the collapsed question elements.
export const PAA_EXTRACT_SCRIPT = String.raw`(() => {
  const out = [];
  const candidates = Array.from(document.querySelectorAll('div[data-q], div.related-question-pair, span[role="button"]'));
  for (const el of candidates) {
    const q = (el.getAttribute('data-q') || el.innerText || '').replace(/\s+/g, ' ').trim();
    if (q) out.push(q);
  }
  // Fall back to the legacy rendered list when data-q is absent.
  if (out.length === 0) {
    const headings = Array.from(document.querySelectorAll('h4'));
    for (const h of headings) {
      const q = (h.innerText || '').replace(/\s+/g, ' ').trim();
      if (q) out.push(q);
    }
  }
  return out;
})()`;

// Normalizes and de-duplicates raw PAA question strings. Keeps first-appearance
// order; trims and collapses whitespace; case-insensitive dedup.
export function parseGooglePaa(rawTexts: string[]): string[] {
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
