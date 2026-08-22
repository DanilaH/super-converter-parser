export type ResearchErrorCode =
  | 'BROWSER_CONNECTION_ERROR'
  | 'SURFER_NOT_DETECTED'
  | 'SURFER_PARSE_ERROR'
  | 'SURFER_RELATED_PARSE_ERROR'
  | 'SURFER_RELATED_WIDGET_MISSING'
  | 'GOOGLE_SERP_PARSE_ERROR'
  | 'AHREFS_RATE_LIMIT'
  | 'AHREFS_ERROR'
  | 'AHREFS_NOT_CONFIGURED'
  | 'AHREFS_REQUIRE_CONFIG'
  | 'GOOGLE_UNAVAILABLE'
  | 'CAPTCHA_REQUIRED'
  | 'RUN_PAUSED'
  | 'INPUT_SCHEMA_ERROR'
  | 'OUTPUT_WRITE_ERROR'
  | 'DB_ERROR'
  | 'CACHE_DB_ERROR'
  | 'RESUME_NOT_FOUND'
  | 'RESUME_TERMINAL_RUN'
  | 'RESUME_PARSER_MISMATCH'
  | 'RESUME_CONFIG_MISMATCH';

export class ResearchError extends Error {
  readonly code: ResearchErrorCode;
  /** Optional HTTP status code (e.g. 401, 403, 429, 5xx) for explicit auth/systemic classification. */
  readonly httpStatus: number | undefined;

  constructor(code: ResearchErrorCode, message: string, options?: { cause?: unknown; httpStatus?: number }) {
    super(message, options);
    this.name = 'ResearchError';
    this.code = code;
    this.httpStatus = options?.httpStatus;
  }
}