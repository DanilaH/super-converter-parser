import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobotsTxt, getRobotsUrl } from './robots.js';
import { parseSitemap, sampleUrls } from './sitemap.js';

test('parseRobotsTxt: extracts sitemap URLs', () => {
  const content = `
User-agent: *
Allow: /

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap2.xml
  `;

  const result = parseRobotsTxt(content);
  assert.deepEqual(result.sitemapUrls, [
    'https://example.com/sitemap.xml',
    'https://example.com/sitemap2.xml',
  ]);
});

test('parseRobotsTxt: handles case-insensitive directive', () => {
  const content = 'SITEMAP: https://example.com/sitemap.xml\nsitemap: https://example.com/sitemap2.xml';
  const result = parseRobotsTxt(content);
  assert.equal(result.sitemapUrls.length, 2);
});

test('parseRobotsTxt: handles comments and empty lines', () => {
  const content = `
# This is a comment
Sitemap: https://example.com/sitemap.xml

# Another comment
  `;

  const result = parseRobotsTxt(content);
  assert.deepEqual(result.sitemapUrls, ['https://example.com/sitemap.xml']);
});

test('parseRobotsTxt: records errors for invalid URLs', () => {
  const content = 'Sitemap: not-a-valid-url';
  const result = parseRobotsTxt(content);
  assert.equal(result.sitemapUrls.length, 0);
  assert.equal(result.errors.length, 1);
});

test('parseRobotsTxt: returns empty for no sitemap directives', () => {
  const content = 'User-agent: *\nAllow: /';
  const result = parseRobotsTxt(content);
  assert.deepEqual(result.sitemapUrls, []);
});

test('getRobotsUrl: constructs correct URL', () => {
  assert.equal(getRobotsUrl('example.com'), 'https://example.com/robots.txt');
});

test('parseSitemap: parses urlset', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
  <url><loc>https://example.com/page3</loc></url>
</urlset>`;

  const result = parseSitemap(xml);
  assert.equal(result.sitemapType, 'urlset');
  assert.equal(result.urls.length, 3);
  assert.equal(result.sitemapUrls.length, 0);
  assert.equal(result.error, null);
});

test('parseSitemap: parses sitemapindex', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap2.xml</loc></sitemap>
</sitemapindex>`;

  const result = parseSitemap(xml);
  assert.equal(result.sitemapType, 'index');
  assert.equal(result.sitemapUrls.length, 2);
  assert.equal(result.urls.length, 0);
  assert.equal(result.error, null);
});

test('parseSitemap: handles RSS feed', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <link>https://example.com</link>
    <item><link>https://example.com/post1</link></item>
  </channel>
</rss>`;

  const result = parseSitemap(xml);
  assert.equal(result.sitemapType, 'unknown');
  assert.ok(result.urls.length > 0);
});

test('parseSitemap: returns error for unknown format', () => {
  const xml = '<html><body>Not a sitemap</body></html>';
  const result = parseSitemap(xml);
  assert.equal(result.sitemapType, 'unknown');
  assert.ok(result.error);
});

test('parseSitemap: skips invalid URLs', () => {
  const xml = `<urlset><url><loc>not-a-url</loc></url><url><loc>https://example.com/ok</loc></url></urlset>`;
  const result = parseSitemap(xml);
  assert.deepEqual(result.urls, ['https://example.com/ok']);
});

test('sampleUrls: returns all when under limit', () => {
  const urls = ['a', 'b', 'c'];
  assert.deepEqual(sampleUrls(urls, 10), urls);
});

test('sampleUrls: samples uniformly when over limit', () => {
  const urls = Array.from({ length: 100 }, (_, i) => `url-${i}`);
  const sampled = sampleUrls(urls, 10);
  assert.equal(sampled.length, 10);
  assert.notDeepEqual(sampled, urls.slice(0, 10));
});

test('sampleUrls: handles exact limit', () => {
  const urls = ['a', 'b', 'c'];
  assert.deepEqual(sampleUrls(urls, 3), urls);
});
