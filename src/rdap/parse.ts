// Pure RDAP JSON parser. No I/O: takes a parsed JSON body and a domain, returns
// a typed registration result. This is where the "documented rule used to
// select registrationDate" is enforced, so all selection logic lives here.
import type {
  RdapEventCandidate,
  RdapRegistrationResult,
  RdapRegistrationStatus,
} from './types.js';
import {
  REGISTRATION_ACTION_SET,
  REGISTRATION_RULE_EARLIEST,
  REGISTRATION_RULE_NO_EVENT,
  REGISTRATION_RULE_SINGLE,
} from './types.js';

export type ParseOpts = {
  fetchedAt: string;
};

// Parse a domain object (RFC 9083 objectClassName === 'domain') into a
// registration result. HTTP-level outcomes (404, 4xx, 5xx) are handled by the
// client, which calls this only for 2xx bodies; a body that is an RDAP error
// object (objectClassName !== 'domain') is reported as a parse-level error
// status here only for malformed structure, while structured HTTP errors stay
// the client's responsibility.
export function parseRdapDomainResponse(
  domain: string,
  json: unknown,
  opts: ParseOpts,
): RdapRegistrationResult {
  if (!isPlainObject(json)) {
    return errorResult(domain, opts, 'malformed: response is not a JSON object');
  }

  const obj = json as Record<string, unknown>;

  // RDAP error responses (RFC 7480 §6) carry an errorCode/title instead of a
  // domain object. Treat these as a structured parse error so the run records
  // the reason rather than pretending a date was found.
  if (obj.objectClassName !== 'domain' && (obj.errorCode !== undefined || obj.title !== undefined)) {
    const title = typeof obj.title === 'string' ? obj.title : '';
    const code = typeof obj.errorCode === 'number' ? obj.errorCode : null;
    return errorResult(
      domain,
      opts,
      `rdap_error: ${code != null ? `${code} ` : ''}${title || 'unknown RDAP error'}`,
    );
  }

  if (obj.objectClassName !== 'domain') {
    return errorResult(domain, opts, "malformed: objectClassName is not 'domain'");
  }

  const events = readEvents(obj);
  const isRedacted = detectRedaction(obj);
  const { date, rule } = selectRegistrationDate(events);

  // 'ok' means the RDAP server responded with a domain object we could process.
  // registrationDate may still be null (privacy redaction, ambiguous/missing
  // events) — that is an honest "fact absent", not a failure of the lookup.
  return {
    domain,
    registrationDate: date,
    status: 'ok',
    error: date === null ? (isRedacted ? 'registration event redacted or absent' : null) : null,
    source: 'rdap',
    rule,
    events,
    isRedacted,
    fetchedAt: opts.fetchedAt,
    requestCount: 0,
    httpStatus: null,
  };
}

export function selectRegistrationDate(events: RdapEventCandidate[]): {
  date: string | null;
  rule: string;
} {
  // Compare candidates by parsed instant, never lexically: ISO-8601 values with
  // different offsets/timezones/frac-second formats are not string-orderable, and
  // malformed dates must be dropped rather than retained as the chosen earliest.
  // The raw eventDate string is preserved on the chosen candidate for audit.
  const candidates: Array<{ date: string; instant: number }> = [];
  let invalidCount = 0;
  for (const event of events) {
    if (!REGISTRATION_ACTION_SET.has(event.eventAction) || !event.eventDate) continue;
    const instant = Date.parse(event.eventDate);
    if (!Number.isNaN(instant)) {
      candidates.push({ date: event.eventDate, instant });
    } else {
      invalidCount += 1;
    }
  }
  if (candidates.length === 0) {
    const rule = invalidCount > 0
      ? `${REGISTRATION_RULE_NO_EVENT} (dropped ${invalidCount} unparseable registration-class date(s))`
      : REGISTRATION_RULE_NO_EVENT;
    return { date: null, rule };
  }
  candidates.sort((a, b) => a.instant - b.instant);
  const chosen = candidates[0] as { date: string; instant: number };
  const rule =
    candidates.length === 1
      ? `${REGISTRATION_RULE_SINGLE}${invalidCount > 0 ? ` (dropped ${invalidCount} unparseable date(s))` : ''}`
      : invalidCount > 0
        ? `${REGISTRATION_RULE_EARLIEST} (dropped ${invalidCount} unparseable date(s))`
        : REGISTRATION_RULE_EARLIEST;
  return { date: chosen.date, rule };
}

function readEvents(obj: Record<string, unknown>): RdapEventCandidate[] {
  const raw = obj.events;
  if (!Array.isArray(raw)) return [];
  const out: RdapEventCandidate[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const action = typeof item.eventAction === 'string' ? item.eventAction : null;
    if (action === null) continue;
    const date = typeof item.eventDate === 'string' ? item.eventDate : null;
    out.push({ eventAction: action, eventDate: date, source: 'event' });
  }
  return out;
}

// RFC 9537 `redacted` array (structured redaction) OR a `notices` block whose
// description mentions redaction/privacy. This lets us distinguish
// "fact absent because redacted" from "fact absent because unsupported".
function detectRedaction(obj: Record<string, unknown>): boolean {
  if (Array.isArray(obj.redacted) && obj.redacted.length > 0) return true;
  const notices = obj.notices;
  if (Array.isArray(notices)) {
    for (const notice of notices) {
      if (!isPlainObject(notice)) continue;
      const description = (notice as Record<string, unknown>).description;
      if (!Array.isArray(description)) continue;
      for (const line of description) {
        if (typeof line === 'string' && /redact|privacy/i.test(line)) return true;
      }
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(
  domain: string,
  opts: ParseOpts,
  message: string,
): RdapRegistrationResult {
  return {
    domain,
    registrationDate: null,
    status: 'error',
    error: message,
    source: 'rdap',
    rule: 'unreachable',
    events: [],
    isRedacted: false,
    fetchedAt: opts.fetchedAt,
    requestCount: 0,
    httpStatus: null,
  };
}

// Re-export the rule constants and status type so the engine/outputs and tests
// share one source of truth with this parser.
export {
  REGISTRATION_ACTION_SET,
  REGISTRATION_RULE_EARLIEST,
  REGISTRATION_RULE_NO_EVENT,
  REGISTRATION_RULE_SINGLE,
  type RdapRegistrationStatus,
};
