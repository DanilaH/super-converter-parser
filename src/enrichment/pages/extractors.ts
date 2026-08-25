import type { FormCounts } from './types.js';

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function stripScriptStyle(html: string): string {
  let result = html;
  result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  result = result.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  result = result.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  result = result.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, '');
  return result;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

export function extractTitle(html: string): string | null {
  const cleanHtml = stripScriptStyle(html);
  const match = cleanHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;

  const content = stripTags(match[1]!.trim());
  const decoded = decodeEntities(content).trim();
  return decoded || null;
}

export function extractMetaDescription(html: string): string | null {
  const patterns = [
    /<meta\s+(?:name=["']description["']\s+content=["']([^"']*)["']|content=["']([^"']*)["']\s+name=["']description["'])/i,
    /<meta\s+(?:property=["']og:description["']\s+content=["']([^"']*)["']|content=["']([^"']*)["']\s+property=["']og:description["'])/i,
    /<meta\s+(?:name=["']twitter:description["']\s+content=["']([^"']*)["']|content=["']([^"']*)["']\s+name=["']twitter:description["'])/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      const content = (match[1] ?? match[2] ?? '').trim();
      if (content) {
        const decoded = decodeEntities(content);
        if (decoded) return decoded;
      }
    }
  }

  return null;
}

export function extractH1(html: string): string | null {
  const cleanHtml = stripScriptStyle(html);
  const match = cleanHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match) return null;

  const content = stripTags(match[1]!.trim());
  const decoded = decodeEntities(content).trim();
  return decoded || null;
}

export function extractCanonical(html: string): string | null {
  const patterns = [
    /<link\s+(?:rel=["']canonical["']\s+href=["']([^"']*)["']|href=["']([^"']*)["']\s+rel=["']canonical["'])/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      const href = (match[1] ?? match[2] ?? '').trim();
      if (href) return href;
    }
  }

  return null;
}

export function resolveCanonical(canonical: string | null, finalUrl: string): string | null {
  if (!canonical) return null;
  if (canonical.startsWith('http://') || canonical.startsWith('https://') || canonical.startsWith('//')) {
    return canonical;
  }
  try {
    return new URL(canonical, finalUrl).href;
  } catch {
    return canonical;
  }
}

export function extractLanguage(html: string): string | null {
  const match = html.match(/<html\b[^>]*\slang=["']([^"']*)["']/i);
  if (match) return match[1]!.trim() || null;

  const metaMatch = html.match(/<meta\s+http-equiv=["']content-language["']\s+content=["']([^"']*)["']/i);
  if (metaMatch) return metaMatch[1]!.trim() || null;

  return null;
}

export function extractWordCount(html: string): number | null {
  const cleanHtml = stripScriptStyle(html);
  const text = stripTags(cleanHtml).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const words = text.split(' ').filter((w) => w.length > 0);
  return words.length;
}

export function extractForms(html: string): FormCounts {
  const formCount = (html.match(/<form\b/gi) ?? []).length;
  const textareaCount = (html.match(/<textarea\b/gi) ?? []).length;
  const inputCount = (html.match(/<input\b/gi) ?? []).length;
  const fileInputCount = (html.match(/<input\b[^>]*type=["']file["']/gi) ?? []).length;
  const buttonCount = (html.match(/<button\b/gi) ?? []).length;

  return { formCount, textareaCount, inputCount, fileInputCount, buttonCount };
}

export function extractStructuredData(html: string): string[] {
  const types = new Set<string>();
  const ldJsonRegex = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = ldJsonRegex.exec(html)) !== null) {
    const jsonContent = match[1]!.trim();
    if (!jsonContent) continue;

    try {
      const parsed = JSON.parse(jsonContent);

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object' && '@type' in item) {
            types.add(String(item['@type']));
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        if ('@type' in parsed) {
          types.add(String(parsed['@type']));
        } else if ('@graph' in parsed && Array.isArray(parsed['@graph'])) {
          for (const item of parsed['@graph']) {
            if (item && typeof item === 'object' && '@type' in item) {
              types.add(String(item['@type']));
            }
          }
        }
      }
    } catch {
      // Malformed JSON-LD: skip this block
    }
  }

  return [...types];
}

export function extractAll(html: string): {
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  canonical: string | null;
  language: string | null;
  wordCount: number | null;
  possiblyJsRendered: boolean;
  forms: FormCounts;
  structuredDataTypes: string[];
} {
  const wordCount = extractWordCount(html);
  const forms = extractForms(html);
  const scriptCount = (html.match(/<script\b/gi) ?? []).length;
  const hasAppRoot = /<(?:div|main)\b[^>]*\bid=["'](?:root|app|__next|__nuxt)["']/i.test(html);
  const hasModuleBootstrap = /<script\b[^>]*(?:type=["']module["']|src=["'][^"']*(?:bundle|chunk|main|app)[^"']*\.js)/i.test(html);
  const hasNoControls = forms.formCount === 0
    && forms.textareaCount === 0
    && forms.inputCount === 0
    && forms.buttonCount === 0;
  const possiblyJsRendered = wordCount !== null
    && wordCount <= 25
    && hasNoControls
    && ((hasAppRoot && scriptCount > 0) || scriptCount >= 3 || hasModuleBootstrap);

  return {
    title: extractTitle(html),
    metaDescription: extractMetaDescription(html),
    h1: extractH1(html),
    canonical: extractCanonical(html),
    language: extractLanguage(html),
    wordCount,
    possiblyJsRendered,
    forms,
    structuredDataTypes: extractStructuredData(html),
  };
}
