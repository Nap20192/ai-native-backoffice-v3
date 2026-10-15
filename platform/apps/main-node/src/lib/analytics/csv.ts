function field(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"','""')}"` : text;
}
export function csv(headers: readonly string[], rows: unknown[][]): string {
  return [headers,...rows].map(row => row.map(field).join(',')).join('\r\n') + '\r\n';
}
