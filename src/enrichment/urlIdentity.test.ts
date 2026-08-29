import test from 'node:test';
import assert from 'node:assert/strict';
import { CLUSTER_URL_IDENTITY_VERSION, clusteringUrlIdentity } from './urlIdentity.js';

test('URL identity contract is explicitly versioned', () => {
  assert.equal(CLUSTER_URL_IDENTITY_VERSION, '1.0.0');
});

test('normalizes presentation and tracking noise without mutating semantic query identity', () => {
  assert.equal(
    clusteringUrlIdentity('https://www.Example.com/tool/?utm_source=google&srsltid=abc#section'),
    'example.com/tool',
  );
  assert.equal(
    clusteringUrlIdentity('http://example.com/tool?fbclid=x&utm_medium=cpc'),
    'example.com/tool',
  );

  assert.equal(
    clusteringUrlIdentity('https://www.youtube.com/watch?vl=en&v=abc123&utm_source=test'),
    'youtube.com/watch?v=abc123&vl=en',
  );
  assert.notEqual(
    clusteringUrlIdentity('https://youtube.com/watch?v=abc123'),
    clusteringUrlIdentity('https://youtube.com/watch?v=other'),
  );
});

test('preserves meaningful subdomain and path differences', () => {
  assert.notEqual(
    clusteringUrlIdentity('https://m.example.com/tool'),
    clusteringUrlIdentity('https://example.com/tool'),
  );
  assert.notEqual(
    clusteringUrlIdentity('https://example.com/Tool'),
    clusteringUrlIdentity('https://example.com/tool'),
  );
});

test('returns null for malformed or non-http URLs', () => {
  assert.equal(clusteringUrlIdentity('not a url'), null);
  assert.equal(clusteringUrlIdentity('mailto:test@example.com'), null);
});
