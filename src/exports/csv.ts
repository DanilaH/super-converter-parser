// RFC 4180-compatible CSV rendering with spreadsheet-formula protection.
// No runtime dependency: the writer is small, deterministic, and fully
// covered by tests.

// Cells that begin (after optional leading whitespace) with one of these
// characters are prefixed with a single quote so spreadsheet applications
// treat them as text instead of executing them as a formula.
const FORMULA_PREFIXES = ['=', '+', '-', '@'] as const;

export function escapeCsvCell(raw: string): string {
  let value = raw;
  const firstSignificant = value.replace(/^\s+/, '').charAt(0);
  if (
    firstSignificant !== '' &&
    (FORMULA_PREFIXES as readonly string[]).includes(firstSignificant)
  ) {
    value = `'${value}`;
  }
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Renders a complete CSV document: UTF-8 BOM, CRLF row endings, and every
// cell escaped through escapeCsvCell. The caller controls row and column
// order, so output is fully deterministic.
export function renderCsv(rows: string[][]): string {
  const lines = rows.map((cells) => cells.map(escapeCsvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}