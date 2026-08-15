import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrganicResults,
  detectGoogleLocationFromText,
  geoMatchesMarket,
  isNoResultsPageText,
} from './serp.js';

test('buildOrganicResults builds organic rows in order', () => {
  const results = buildOrganicResults(
    [
      { href: 'https://example.com/a', title: 'A' },
      { href: 'https://example.org/b', title: 'B' },
    ],
    'compare lists',
    10,
  );

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((item) => item.position),
    [1, 2],
  );
  assert.equal(results[0]!.keyword, 'compare lists');
  assert.equal(results[0]!.hostname, 'example.com');
  assert.equal(results[0]!.resultType, 'organic');
});

test('buildOrganicResults excludes Google navigation and ad redirect links', () => {
  const results = buildOrganicResults(
    [
      { href: 'https://www.google.com/url?q=https://advertiser.example', title: 'Ad' },
      { href: 'https://maps.google.com/place/Example', title: 'Map' },
      { href: 'https://example.com/real', title: 'Real result' },
    ],
    'compare lists',
    10,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.url, 'https://example.com/real');
});

test('buildOrganicResults dedupes identical URLs and caps at topN', () => {
  const raw = [
    { href: 'https://example.com/a', title: 'A' },
    { href: 'https://example.com/a', title: 'A duplicate' },
    { href: 'https://example.com/b', title: 'B' },
    { href: 'https://example.com/c', title: 'C' },
  ];

  const results = buildOrganicResults(raw, 'compare lists', 2);
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((item) => item.url),
    ['https://example.com/a', 'https://example.com/b'],
  );
});

test('buildOrganicResults accepts nine organic results when only nine exist', () => {
  const raw = Array.from({ length: 9 }, (_, index) => ({
    href: `https://example${index}.com/`,
    title: `Result ${index}`,
  }));

  const results = buildOrganicResults(raw, 'compare lists', 10);
  assert.equal(results.length, 9);
});

test('buildOrganicResults skips malformed URLs and non-http protocols', () => {
  const results = buildOrganicResults(
    [
      { href: 'not a url', title: 'Broken' },
      { href: 'javascript:void(0)', title: 'Script' },
      { href: 'https://example.com/ok', title: 'OK' },
    ],
    'compare lists',
    10,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.url, 'https://example.com/ok');
});

test('detectGoogleLocationFromText extracts location from footer line', () => {
  assert.equal(
    detectGoogleLocationFromText('Chelyabinsk Oblast, Russia - Based on your places (Home)'),
    'Chelyabinsk Oblast, Russia',
  );
  assert.equal(
    detectGoogleLocationFromText('New York, NY - Based on your past activity'),
    'New York, NY',
  );
  assert.equal(detectGoogleLocationFromText('no location marker here'), null);
  assert.equal(detectGoogleLocationFromText(''), null);
});

test('geoMatchesMarket detects US mismatch', () => {
  assert.equal(geoMatchesMarket('US', 'Chelyabinsk Oblast, Russia'), false);
  assert.equal(geoMatchesMarket('US', 'United States'), true);
  assert.equal(geoMatchesMarket('US', 'USA'), true);
  assert.equal(geoMatchesMarket('US', 'California, United States'), true);
});

test('geoMatchesMarket handles generic market labels', () => {
  assert.equal(geoMatchesMarket('Germany', 'Berlin, Germany'), true);
  assert.equal(geoMatchesMarket('Germany', 'Moscow, Russia'), false);
});

test('isNoResultsPageText detects genuine zero-result pages', () => {
  assert.equal(
    isNoResultsPageText('Your search - xyz - did not match any documents. Suggestions: ...'),
    true,
  );
  assert.equal(isNoResultsPageText('No results found for "xyz".'), true);
  assert.equal(isNoResultsPageText('compare lists - Google Search\n49,500 results in 0.4s'), false);
  assert.equal(isNoResultsPageText(''), false);
});