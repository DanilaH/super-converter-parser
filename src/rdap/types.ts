// RDAP (Registration Data Access Protocol) types for domain registration-date
// enrichment. See RFC 9082 (query format), RFC 9083 (JSON responses), and
// RFC 9224 (IANA bootstrap / server discovery).
//
// registrationDate and firstSeenDate are intentionally produced by separate
// providers (RDAP and a first-seen provider) so they can never alias one another.

export const RDAP_PARSER_VERSION = '1.0.0';

export type RdapRegistrationStatus = 'ok' | 'not_found' | 'unsupported' | 'error';

// A single candidate registration event extracted from an RDAP response. The
// `source` field records where the candidate came from so provenance survives.
export type RdapEventCandidate = {
  eventAction: string;
  eventDate: string | null;
  source: 'event';
};

export type RdapRegistrationResult = {
  domain: string;
  registrationDate: string | null;
  status: RdapRegistrationStatus;
  error: string | null;
  source: 'rdap';
  // The documented rule used to select registrationDate (e.g. "earliest eventAction
  // 'registration'"). Always present when status === 'ok' so the selection is
  // auditable and not silently changed later.
  rule: string;
  events: RdapEventCandidate[];
  // True when the response carried RFC 9537 redaction signals or an explicit
  // "REDACTED" notice. Distinguishes privacy-gated absence from a missing event.
  isRedacted: boolean;
  fetchedAt: string;
  requestCount: number;
  httpStatus: number | null;
};

export type RdapClient = (domain: string) => Promise<RdapRegistrationResult>;

export type RdapClientConfig = {
  bootstrapBase: string;
  bootstrapFile: string;
  bootstrapTtlMs: number;
  queryTimeoutMs: number;
  perHostMinDelayMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
  fetchImpl?: typeof fetch | undefined;
  // Test seams (mirror the hooks pattern used by runs/engine applyDomainRatings).
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// Event actions that RFC 9083 / registries use to mark a registration/creation
// event. 'registration' is canonical; 'add' and 'create' are common aliases.
export const REGISTRATION_EVENT_ACTIONS = ['registration', 'add', 'create'] as const;
export const REGISTRATION_ACTION_SET: ReadonlySet<string> = new Set([
  'registration',
  'add',
  'create',
]);

export const REGISTRATION_RULE_EARLIEST =
  "earliest eventDate among eventAction in {registration, add, create}";
export const REGISTRATION_RULE_NO_EVENT =
  "no registration-class event present; registrationDate unavailable";
export const REGISTRATION_RULE_SINGLE =
  "single registration-class event; its eventDate used as registrationDate";
