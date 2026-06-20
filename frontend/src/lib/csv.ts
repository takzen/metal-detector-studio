// Client-side CSV download for chart data (time-series, spectra).

function cell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows -> RFC-4180-ish CSV text (CRLF lines). */
export function toCsv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

/** Trigger a browser download of `rows` as a timestamped CSV file. */
export function downloadCsv(name: string, rows: (string | number)[][]): void {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.download = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
}
