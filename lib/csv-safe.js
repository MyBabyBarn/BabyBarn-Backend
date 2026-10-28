/**
 * SEC-10: CSV cell escaping that also neutralises spreadsheet formula injection.
 * Prefix cells that start with =, +, -, @, or tab/CR with a single quote.
 */
export function escapeCsvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(header, rows) {
  const lines = rows.map((row) => row.map(escapeCsvCell).join(','));
  return [header.map(escapeCsvCell).join(','), ...lines].join('\r\n');
}
