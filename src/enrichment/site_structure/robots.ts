export type RobotsParseResult = {
  sitemapUrls: string[];
  errors: string[];
};

export function parseRobotsTxt(content: string): RobotsParseResult {
  const sitemapUrls: string[] = [];
  const errors: string[] = [];

  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) continue;

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const directive = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (directive === 'sitemap' && value) {
      try {
        const url = new URL(value).href;
        sitemapUrls.push(url);
      } catch {
        errors.push(`Invalid sitemap URL in robots.txt: ${value}`);
      }
    }
  }

  return { sitemapUrls, errors };
}

export function getRobotsUrl(domain: string): string {
  return `https://${domain}/robots.txt`;
}
