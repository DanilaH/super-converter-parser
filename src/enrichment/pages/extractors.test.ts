import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTitle,
  extractMetaDescription,
  extractH1,
  extractCanonical,
  extractLanguage,
  extractWordCount,
  extractForms,
  extractStructuredData,
  extractAll,
} from './extractors.js';

test('extractTitle: extracts title content', () => {
  assert.equal(extractTitle('<html><head><title>Hello World</title></head></html>'), 'Hello World');
});

test('extractTitle: handles HTML entities', () => {
  assert.equal(extractTitle('<title>Foo &amp; Bar</title>'), 'Foo & Bar');
});

test('extractTitle: returns null when missing', () => {
  assert.equal(extractTitle('<html><body>No title</body></html>'), null);
});

test('extractTitle: handles nested tags', () => {
  assert.equal(extractTitle('<title>Main <span>Page</span></title>'), 'Main Page');
});

test('extractMetaDescription: extracts from name attribute', () => {
  const html = '<meta name="description" content="A test page">';
  assert.equal(extractMetaDescription(html), 'A test page');
});

test('extractMetaDescription: extracts from content-first format', () => {
  const html = '<meta content="Another description" name="description">';
  assert.equal(extractMetaDescription(html), 'Another description');
});

test('extractMetaDescription: falls back to og:description', () => {
  const html = '<meta property="og:description" content="OG description">';
  assert.equal(extractMetaDescription(html), 'OG description');
});

test('extractMetaDescription: returns null when missing', () => {
  assert.equal(extractMetaDescription('<html></html>'), null);
});

test('extractH1: extracts h1 content', () => {
  assert.equal(extractH1('<h1>Main Heading</h1>'), 'Main Heading');
});

test('extractH1: returns first h1 when multiple', () => {
  assert.equal(extractH1('<h1>First</h1><h1>Second</h1>'), 'First');
});

test('extractH1: handles nested tags', () => {
  assert.equal(extractH1('<h1>Welcome <em>here</em></h1>'), 'Welcome here');
});

test('extractH1: returns null when missing', () => {
  assert.equal(extractH1('<h2>Not h1</h2>'), null);
});

test('extractCanonical: extracts canonical URL', () => {
  const html = '<link rel="canonical" href="https://example.com/page">';
  assert.equal(extractCanonical(html), 'https://example.com/page');
});

test('extractCanonical: handles reverse attribute order', () => {
  const html = '<link href="https://example.com/page" rel="canonical">';
  assert.equal(extractCanonical(html), 'https://example.com/page');
});

test('extractCanonical: returns null when missing', () => {
  assert.equal(extractCanonical('<html></html>'), null);
});

test('extractLanguage: extracts from html lang attribute', () => {
  assert.equal(extractLanguage('<html lang="en">'), 'en');
  assert.equal(extractLanguage('<html lang="en-US">'), 'en-US');
});

test('extractLanguage: falls back to meta http-equiv', () => {
  assert.equal(extractLanguage('<html><meta http-equiv="content-language" content="fr"></html>'), 'fr');
});

test('extractLanguage: returns null when missing', () => {
  assert.equal(extractLanguage('<html><body></body></html>'), null);
});

test('extractWordCount: counts words in text', () => {
  const html = '<html><body><p>Hello world foo bar</p></body></html>';
  assert.equal(extractWordCount(html), 4);
});

test('extractWordCount: handles multiple spaces', () => {
  const html = '<html><body><p>Hello    world</p></body></html>';
  assert.equal(extractWordCount(html), 2);
});

test('extractWordCount: returns null for empty content', () => {
  assert.equal(extractWordCount('<html><body></body></html>'), null);
});

test('extractForms: counts form elements', () => {
  const html = `
    <form>
      <input type="text">
      <input type="file">
      <textarea></textarea>
      <button>Submit</button>
    </form>
    <form>
      <input type="email">
    </form>
  `;
  const result = extractForms(html);
  assert.equal(result.formCount, 2);
  assert.equal(result.inputCount, 3);
  assert.equal(result.fileInputCount, 1);
  assert.equal(result.textareaCount, 1);
  assert.equal(result.buttonCount, 1);
});

test('extractForms: returns zeros when no forms', () => {
  const result = extractForms('<html><body><p>No forms</p></body></html>');
  assert.equal(result.formCount, 0);
  assert.equal(result.inputCount, 0);
  assert.equal(result.fileInputCount, 0);
  assert.equal(result.textareaCount, 0);
  assert.equal(result.buttonCount, 0);
});

test('extractStructuredData: extracts @type from JSON-LD', () => {
  const html = '<script type="application/ld+json">{"@type": "Article", "name": "Test"}</script>';
  assert.deepEqual(extractStructuredData(html), ['Article']);
});

test('extractStructuredData: handles array of objects', () => {
  const html = '<script type="application/ld+json">[{"@type": "Article"}, {"@type": "BreadcrumbList"}]</script>';
  assert.deepEqual(extractStructuredData(html).sort(), ['Article', 'BreadcrumbList']);
});

test('extractStructuredData: handles @graph', () => {
  const html = '<script type="application/ld+json">{"@graph": [{"@type": "Organization"}, {"@type": "WebSite"}]}</script>';
  assert.deepEqual(extractStructuredData(html).sort(), ['Organization', 'WebSite']);
});

test('extractStructuredData: skips malformed JSON', () => {
  const html = '<script type="application/ld+json">{invalid json}</script>';
  assert.deepEqual(extractStructuredData(html), []);
});

test('extractStructuredData: handles empty script', () => {
  const html = '<script type="application/ld+json"></script>';
  assert.deepEqual(extractStructuredData(html), []);
});

test('extractStructuredData: deduplicates types', () => {
  const html = `
    <script type="application/ld+json">{"@type": "Article"}</script>
    <script type="application/ld+json">{"@type": "Article"}</script>
  `;
  assert.deepEqual(extractStructuredData(html), ['Article']);
});

test('extractAll: extracts all fields at once', () => {
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Test Page</title>
      <meta name="description" content="A test">
      <link rel="canonical" href="https://example.com/test">
      <script type="application/ld+json">{"@type": "Article"}</script>
    </head>
    <body>
      <h1>Welcome</h1>
      <p>This is a test page with some content.</p>
      <form>
        <input type="text">
        <button>Go</button>
      </form>
    </body>
    </html>
  `;

  const result = extractAll(html);
  assert.equal(result.title, 'Test Page');
  assert.equal(result.metaDescription, 'A test');
  assert.equal(result.h1, 'Welcome');
  assert.equal(result.canonical, 'https://example.com/test');
  assert.equal(result.language, 'en');
  assert.equal(result.wordCount, 12);
  assert.equal(result.possiblyJsRendered, false);
  assert.equal(result.forms.formCount, 1);
  assert.equal(result.forms.inputCount, 1);
  assert.equal(result.forms.buttonCount, 1);
  assert.deepEqual(result.structuredDataTypes, ['Article']);
});

test('extractAll: flags a thin JavaScript application shell without classifying it as an error', () => {
  const result = extractAll(`
    <html><head><title>Utility</title></head><body>
      <div id="root">Loading</div>
      <script src="runtime.js"></script>
      <script src="vendors.js"></script>
      <script src="app.js"></script>
    </body></html>
  `);
  assert.equal(result.wordCount, 2);
  assert.equal(result.possiblyJsRendered, true);
});

test('extractAll: does not flag a small static form as a JavaScript shell', () => {
  const result = extractAll(`
    <html><body><div id="app"><form><input><button>Convert</button></form></div><script src="app.js"></script></body></html>
  `);
  assert.equal(result.possiblyJsRendered, false);
});

test('extractAll: handles malformed HTML gracefully', () => {
  const html = '<html><body><p>Unclosed paragraph<h1>Heading</h1></body></html>';
  const result = extractAll(html);
  assert.equal(result.h1, 'Heading');
  assert.ok(result.wordCount !== null);
});
