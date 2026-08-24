import type { ResearchConfig } from '../config/config.js';

// Google autocomplete (query-language) suggestions. Source = google_autocomplete.
// No volume/CPC is ever derived from this source; the collected text is the
// factual suggestion Google renders for the parent keyword.

export const GOOGLE_AUTOCOMPLETE_PARSER_VERSION = '1.0.0';

// Builds the unofficial Google autocomplete endpoint. The `client` parameter
// selects the JSON-ish response; we intentionally do NOT use the XML toolbar
// format because it is harder to parse and localized inconsistently.
export function buildAutocompleteUrl(query: string, hl: string, gl: string): string {
  const params = new URLSearchParams({
    client: 'firefox',
    q: query,
    hl,
    gl,
  });
  return `https://www.google.com/complete/search?${params.toString()}`;
}

// Pure parser for the autocomplete payload. Google wraps the array in
// `window.google.ac.h(...)` in some clients; plain JSON `[query, [...]]` in
// others. Returns the suggestion strings (index 1) with the echo query dropped.
export function parseGoogleAutocomplete(payload: string): string[] {
  const trimmed = payload.trim();
  if (!trimmed) return [];

  let jsonText = trimmed;
  const acMarker = 'window.google.ac.h(';
  const markerIndex = trimmed.indexOf(acMarker);
  if (markerIndex !== -1) {
    // The first argument of window.google.ac.h(...) is the suggestions array.
    // Extract the outermost [...], ignoring trailing metadata like `, {...})`.
    const start = trimmed.indexOf('[', markerIndex + acMarker.length);
    if (start === -1) return [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return [];
    jsonText = trimmed.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed) || parsed.length < 2 || !Array.isArray(parsed[1])) {
    return [];
  }

  const suggestions = parsed[1] as unknown[];
  const out: string[] = [];
  for (const item of suggestions) {
    if (typeof item === 'string') {
      const value = item.trim();
      if (value) out.push(value);
    } else if (item && typeof item === 'object' && typeof (item as { first?: unknown }).first === 'string') {
      const value = ((item as { first: string }).first).trim();
      if (value) out.push(value);
    }
  }
  return out;
}

// Builds the query-language autocomplete URL for a parent keyword from config.
export function buildAutocompleteUrlForConfig(config: ResearchConfig, query: string): string {
  return buildAutocompleteUrl(query, config.research.googleHl, config.research.googleGl);
}
