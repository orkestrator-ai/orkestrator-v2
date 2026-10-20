/**
 * CSV and Markdown table serialization shared by rich tables and charts.
 *
 * Two CSV modes exist on purpose:
 *  - `exact` writes every cell's text unchanged (RFC 4180 quoting only).
 *  - `spreadsheet-safe` additionally neutralizes text cells that a
 *    spreadsheet would evaluate as a formula. Quote escaping alone does not
 *    stop `=HYPERLINK(...)` from running, so those cells gain a leading `'`.
 *    Typed numbers (including negatives) are never altered.
 * Neither mode changes stored data; it only shapes the exported file.
 */

export type TabularCell = string | number | null;
export type CsvMode = "exact" | "spreadsheet-safe";

const FORMULA_LEADERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function neutralizeSpreadsheetFormula(text: string): string {
  const first = text.charAt(0);
  return FORMULA_LEADERS.has(first) ? `'${text}` : text;
}

export function csvField(cell: TabularCell, mode: CsvMode = "exact"): string {
  if (cell === null) return "";
  let text: string;
  if (typeof cell === "number") {
    text = Number.isFinite(cell) ? String(cell) : "";
  } else {
    text = mode === "spreadsheet-safe" ? neutralizeSpreadsheetFormula(cell) : cell;
  }
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV with CRLF record separators. Prepend a UTF-8 byte-order mark only at download time. */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly TabularCell[])[],
  mode: CsvMode = "exact",
): string {
  const lines = [header.map((cell) => csvField(cell, mode)).join(",")];
  for (const row of rows) lines.push(row.map((cell) => csvField(cell, mode)).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

export type MarkdownAlignment = "left" | "center" | "right" | null;

function markdownCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function toMarkdownTable(
  header: readonly string[],
  rows: readonly (readonly TabularCell[])[],
  align: readonly MarkdownAlignment[] = [],
): string {
  const width = header.length;
  const delimiter = header.map((_, index) => {
    switch (align[index]) {
      case "left":
        return ":---";
      case "center":
        return ":---:";
      case "right":
        return "---:";
      default:
        return "---";
    }
  });
  const format = (cells: readonly TabularCell[]) =>
    `| ${Array.from({ length: width }, (_, index) => {
      const cell = cells[index];
      return markdownCell(cell === null || cell === undefined ? "" : String(cell));
    }).join(" | ")} |`;
  return [format(header), `| ${delimiter.join(" | ")} |`, ...rows.map(format)].join("\n");
}

/** Shortest backtick fence that cannot be terminated by a run inside `body`. */
export function markdownFenceFor(body: string): string {
  let longest = 0;
  for (const match of body.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Language/title info string with characters that could break the fence removed. */
export function safeFenceInfo(language: string | undefined, title: string | undefined): string {
  const lang = (language ?? "").replace(/[^A-Za-z0-9_+#.-]/g, "").slice(0, 40);
  const safeTitle = (title ?? "").replace(/["`\r\n\\]/g, "").slice(0, 120);
  return safeTitle ? `${lang} title="${safeTitle}"`.trim() : lang;
}

export function toMarkdownFence(body: string, language?: string, title?: string): string {
  const fence = markdownFenceFor(body);
  const trailing = body.endsWith("\n") ? "" : "\n";
  return `${fence}${safeFenceInfo(language, title)}\n${body}${trailing}${fence}`;
}
