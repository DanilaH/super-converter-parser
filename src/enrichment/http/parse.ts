export type ContentTypeKind = 'html' | 'text' | 'binary' | 'unknown';

const HTML_TYPES = [
  'text/html',
  'application/xhtml+xml',
];

const TEXT_TYPES = [
  'text/plain',
  'text/xml',
  'application/xml',
  'application/json',
  'text/csv',
  'text/tab-separated-values',
];

export function getContentTypeKind(contentType: string | null): ContentTypeKind {
  if (!contentType) return 'unknown';

  const normalized = contentType.toLowerCase().split(';')[0]?.trim() ?? '';

  if (HTML_TYPES.some((t) => normalized.startsWith(t))) return 'html';
  if (TEXT_TYPES.some((t) => normalized.startsWith(t))) return 'text';

  if (normalized.startsWith('image/') || normalized.startsWith('audio/') || normalized.startsWith('video/')) {
    return 'binary';
  }
  if (normalized.startsWith('application/octet-stream')) return 'binary';
  if (normalized.startsWith('application/pdf')) return 'binary';
  if (normalized.startsWith('application/zip')) return 'binary';
  if (normalized.startsWith('application/gzip')) return 'binary';

  return 'unknown';
}

export function extractCharset(contentType: string | null): string | null {
  if (!contentType) return null;

  const match = contentType.match(/charset=([^\s;]+)/i);
  if (!match) return null;

  let charset = match[1]!.trim().replace(/['"]/g, '');
  if (charset.endsWith(';')) {
    charset = charset.slice(0, -1);
  }

  return charset || null;
}

export function isHtmlContentType(contentType: string | null): boolean {
  return getContentTypeKind(contentType) === 'html';
}

export function isTextContentType(contentType: string | null): boolean {
  return getContentTypeKind(contentType) === 'text' || getContentTypeKind(contentType) === 'html';
}
