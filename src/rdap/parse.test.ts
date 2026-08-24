import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRdapDomainResponse, selectRegistrationDate, REGISTRATION_RULE_NO_EVENT } from './parse.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'rdap');

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

const NOW = '2026-08-23T00:00:00.000Z';

test('parses multiple registration-class events and picks the earliest', () => {
  const result = parseRdapDomainResponse('example.com', readFixture('registration-events.json'), {
    fetchedAt: NOW,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.registrationDate, '2010-05-03T04:00:00Z');
  assert.equal(result.source, 'rdap');
  assert.equal(result.isRedacted, false);
  // Both 'registration' and 'add' are registration-class events → two candidates.
  assert.equal(result.events.filter((e) => e.eventAction === 'registration').length, 1);
  assert.equal(result.events.filter((e) => e.eventAction === 'add').length, 1);
  // The two identical dates make the selection ambiguous (still resolvable).
  assert.equal(result.rule, 'earliest eventDate among eventAction in {registration, add, create}');
});

test('single registration event uses the single rule', () => {
  const result = parseRdapDomainResponse('example.net', readFixture('single-event.json'), {
    fetchedAt: NOW,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.registrationDate, '2015-08-17T09:31:42Z');
  assert.equal(result.rule, 'single registration-class event; its eventDate used as registrationDate');
});

test('missing registration event yields null date, ok status, not redacted', () => {
  const result = parseRdapDomainResponse('noreg.example', readFixture('missing-event.json'), {
    fetchedAt: NOW,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.registrationDate, null);
  assert.equal(result.isRedacted, false);
  assert.equal(result.rule, REGISTRATION_RULE_NO_EVENT);
  assert.equal(result.error, null);
});

test('privacy-redacted notice with empty events sets isRedacted and null date', () => {
  const result = parseRdapDomainResponse(
    'privacyparticipant.example',
    readFixture('privacy-redacted.json'),
    { fetchedAt: NOW },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.registrationDate, null);
  assert.equal(result.isRedacted, true);
  assert.equal(result.events.length, 0);
  // Honest explanation carried in error, not swallowed.
  assert.match(result.error ?? '', /redacted or absent/);
});

test('RFC 9537 structured redaction sets isRedacted even when an event is present', () => {
  const result = parseRdapDomainResponse(
    'redacted.rfc9537',
    readFixture('rfc9537-redacted.json'),
    { fetchedAt: NOW },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.registrationDate, '2001-05-17T03:42:00Z');
  assert.equal(result.isRedacted, true);
});

test('absent events array yields null date with no-event rule', () => {
  const result = parseRdapDomainResponse('noevents.example', readFixture('no-events-array.json'), {
    fetchedAt: NOW,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.registrationDate, null);
  assert.equal(result.events.length, 0);
  assert.equal(result.rule, REGISTRATION_RULE_NO_EVENT);
});

test('RDAP error object (errorCode/title) is reported as a structured error', () => {
  const result = parseRdapDomainResponse('whatever.example', readFixture('rdap-error.json'), {
    fetchedAt: NOW,
  });

  assert.equal(result.status, 'error');
  assert.equal(result.registrationDate, null);
  assert.match(result.error ?? '', /rdap_error/);
});

test('non-object body is a malformed error', () => {
  const result = parseRdapDomainResponse('example.com', readFixture('malformed-not-object.json'), {
    fetchedAt: NOW,
  });

  assert.equal(result.status, 'error');
  assert.equal(result.registrationDate, null);
  assert.match(result.error ?? '', /malformed/);
});

test('selectRegistrationDate never returns a date for non-registration actions', () => {
  const sel = selectRegistrationDate([
    { eventAction: 'expiration', eventDate: '2020-01-01T00:00:00Z', source: 'event' },
    { eventAction: 'last update of RDAP database', eventDate: '2021-01-01T00:00:00Z', source: 'event' },
  ]);
  assert.equal(sel.date, null);
});
