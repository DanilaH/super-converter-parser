export type SitemapParseResult = {
  urls: string[];
  sitemapUrls: string[];
  sitemapType: 'index' | 'urlset' | 'unknown';
  error: string | null;
};

function extractTagContent(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1]!.trim() : '';
}

function extractAllTagContents(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1]!.trim());
  }

  return results;
}

export function parseSitemap(xml: string): SitemapParseResult {
  const trimmed = xml.trim();

  if (trimmed.includes('<sitemapindex') || trimmed.includes('<sitemapindex>')) {
    const locs = extractAllTagContents(trimmed, 'loc');
    const sitemapUrls: string[] = [];

    for (const loc of locs) {
      try {
        sitemapUrls.push(new URL(loc).href);
      } catch {
        // skip invalid URLs
      }
    }

    return { urls: [], sitemapUrls, sitemapType: 'index', error: null };
  }

  if (trimmed.includes('<urlset') || trimmed.includes('<urlset>')) {
    const locs = extractAllTagContents(trimmed, 'loc');
    const urls: string[] = [];

    for (const loc of locs) {
      try {
        urls.push(new URL(loc).href);
      } catch {
        // skip invalid URLs
      }
    }

    return { urls, sitemapUrls: [], sitemapType: 'urlset', error: null };
  }

  if (trimmed.includes('<rss') || trimmed.includes('<feed')) {
    const links = extractAllTagContents(trimmed, 'link');
    const urls: string[] = [];

    for (const link of links) {
      try {
        urls.push(new URL(link).href);
      } catch {
        // skip invalid URLs
      }
    }

    return { urls, sitemapUrls: [], sitemapType: 'unknown', error: null };
  }

  return { urls: [], sitemapUrls: [], sitemapType: 'unknown', error: 'Unrecognized sitemap format' };
}

export function sampleUrls(urls: string[], maxSamples: number): string[] {
  if (urls.length <= maxSamples) return urls;

  const step = urls.length / maxSamples;
  const sampled: string[] = [];

  for (let i = 0; i < maxSamples; i++) {
    const index = Math.floor(i * step);
    sampled.push(urls[index]!);
  }

  return sampled;
}
