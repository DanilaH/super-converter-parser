export type ResearchErrorCode =
  | 'BROWSER_CONNECTION_ERROR'
  | 'SURFER_NOT_DETECTED'
  | 'SURFER_PARSE_ERROR'
  | 'SURFER_RELATED_PARSE_ERROR'
  | 'GOOGLE_SERP_PARSE_ERROR'
  | 'AHREFS_RATE_LIMIT'
  | 'AHREFS_ERROR'
  | 'AHREFS_NOT_CONFIGURED'
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

  constructor(code: ResearchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ResearchError';
    this.code = code;
  }
}