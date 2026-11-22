/**
 * A three-way merge for the repository's Markdown index tables
 * (`docs/todo/**\/0000-index.md`, `docs/tests/flaky-tests/**\/0000-index.md`).
 *
 * Every branch that adds a to-do or a flake case appends a row to the same
 * table, so two such branches always conflict on Git's line merge: both
 * insert after the same last row. The rows are records, not lines of prose,
 * so this merge treats them as records:
 *
 * - each row is keyed by the Case or File column, or its first cell in
 *   other tables;
 * - a row changed on one side only takes that side's version, a row added on
 *   either side is kept, and a row removed on one side is removed unless the
 *   other side changed it;
 * - a `Rank` column is renumbered 1..n after the merge (ranks are positions,
 *   and both sides appending "rank 25" is not a conflict); existing row order is preserved unless one side explicitly changes it.
 *
 * The text around the tables goes through an ordinary three-way text merge.
 * Anything this cannot decide (the same row changed differently on both
 * sides, both sides reordering, a different number of tables, a repeated key)
 * returns null, and the caller falls back to Git's own merge, conflict
 * markers and all. It never guesses.
 */

/** Three-way merge of plain text; null when the sides conflict. */
export type TextMerge = (base: string, ours: string, theirs: string) => string | null;

interface Table {
  readonly columns: readonly string[];
  readonly rows: readonly string[];
}

interface Parsed {
  /** The text with each table's rows replaced by one placeholder line. */
  readonly skeleton: string;
  readonly tables: readonly Table[];
}

const MARKER_PREFIX = "<!-- orkestrator-index-table-";
const placeholder = (index: number) => `${MARKER_PREFIX}${index} -->`;
const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;
const RANK_CELL = /^(\s*)\|\s*\d+\s*\|/;
const LINK = /\]\(([^)\s]+)\)/;

function isTableLine(line: string): boolean {
  return line.startsWith("|");
}

function parse(text: string): Parsed {
  const lines = text.split("\n");
  const out: string[] = [];
  const tables: Table[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (isTableLine(line) && next !== undefined && SEPARATOR.test(next)) {
      const rows: string[] = [];
      let cursor = index + 2;
      while (cursor < lines.length) {
        let nextRow = cursor;
        while (nextRow < lines.length && lines[nextRow]!.trim() === "") nextRow += 1;
        if (nextRow === lines.length || !isTableLine(lines[nextRow]!)) break;
        if (SEPARATOR.test(lines[nextRow + 1] ?? "")) break;
        // Some existing indexes separate batches of rows with blank lines.
        rows.push(lines.slice(cursor, nextRow + 1).join("\n"));
        cursor = nextRow + 1;
      }
      out.push(line, next, placeholder(tables.length));
      tables.push({ columns: cells(line), rows });
      index = cursor - 1;
      continue;
    }
    out.push(line);
  }
  return { skeleton: out.join("\n"), tables };
}

function cells(line: string): string[] {
  return line
    .trimEnd()
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** Keyed rows in order, or null when a key repeats or the table shape is invalid. */
function keyed(table: Table): Map<string, string> | null {
  const caseColumn = table.columns.indexOf("Case");
  const identity = caseColumn >= 0 ? caseColumn : table.columns.indexOf("File");
  const map = new Map<string, string>();
  for (const row of table.rows) {
    const fields = cells(row);
    if (fields.length !== table.columns.length) return null;
    const field = fields[Math.max(identity, 0)];
    const key = field?.match(LINK)?.[1] ?? field;
    if (!key || map.has(key)) return null;
    map.set(key, row);
  }
  return map;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function mergeRows(
  columns: readonly string[],
  base: Table,
  ours: Table,
  theirs: Table,
): string[] | null {
  const ranked = columns[0] === "Rank";
  const comparable = (row: string | undefined) =>
    row === undefined || !ranked ? row : row.replace(RANK_CELL, "$1| # |");

  const b = keyed(base);
  const o = keyed(ours);
  const t = keyed(theirs);
  if (!b || !o || !t) return null;

  // One row per key: the side that changed it wins; both changing it differently is a conflict.
  const merged = new Map<string, string>();
  for (const key of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
    const [inBase, inOurs, inTheirs] = [b.get(key), o.get(key), t.get(key)];
    const [cb, co, ct] = [comparable(inBase), comparable(inOurs), comparable(inTheirs)];
    let row: string | undefined;
    if (co === ct) row = inOurs;
    else if (co === cb) row = inTheirs;
    else if (ct === cb) row = inOurs;
    else return null;
    if (row !== undefined) merged.set(key, row);
  }

  // Order: the side that reordered the rows it shares with the base leads;
  // both reordering is a conflict. The other side's new rows go after the
  // rows that preceded them on that side, past the leading side's own new
  // rows there.
  const shared = (side: Map<string, string>) => [...side.keys()].filter((key) => b.has(key));
  const baseOf = (side: Map<string, string>) => [...b.keys()].filter((key) => side.has(key));
  const oursMoved = !sameOrder(shared(o), baseOf(o));
  const theirsMoved = !sameOrder(shared(t), baseOf(t));
  if (oursMoved && theirsMoved && !sameOrder(shared(o), shared(t))) return null;
  const [lead, follow] = theirsMoved && !oursMoved ? [t, o] : [o, t];

  const order = [...lead.keys()].filter((key) => merged.has(key));
  const followKeys = [...follow.keys()];
  for (const [position, key] of followKeys.entries()) {
    if (order.includes(key) || !merged.has(key)) continue;
    // After every row that preceded it on its own side.
    let at = 0;
    for (const earlier of followKeys.slice(0, position)) {
      at = Math.max(at, order.indexOf(earlier) + 1);
    }
    while (at < order.length && !b.has(order[at]!) && !follow.has(order[at]!)) at += 1;
    order.splice(at, 0, key);
  }

  let rows = order.map((key) => merged.get(key)!);
  // A row remains valid only if one input supplied it under the same columns.
  // A changed header could otherwise reinterpret cells without changing their count.
  const sameLayout = [base, ours, theirs]
    .filter((table) => sameOrder(table.columns, columns))
    .map((table) => new Set(table.rows));
  if (rows.some((row) => !sameLayout.some((layout) => layout.has(row)))) return null;
  if (ranked) rows = rows.map((row, index) => row.replace(RANK_CELL, `$1| ${index + 1} |`));
  return rows;
}

/**
 * The merged index, or null when it cannot be merged without a person.
 * `mergeText` merges the prose around the tables.
 */
export function mergeMarkdownIndex(
  base: string,
  ours: string,
  theirs: string,
  mergeText: TextMerge,
): string | null {
  if ([base, ours, theirs].some((text) => text.includes(MARKER_PREFIX))) return null;
  const [b, o, t] = [parse(base), parse(ours), parse(theirs)];
  if (b.tables.length !== o.tables.length || b.tables.length !== t.tables.length) return null;

  const skeleton =
    o.skeleton === t.skeleton
      ? o.skeleton
      : o.skeleton === b.skeleton
        ? t.skeleton
        : t.skeleton === b.skeleton
          ? o.skeleton
          : mergeText(b.skeleton, o.skeleton, t.skeleton);
  if (skeleton === null) return null;

  const parts: string[] = [];
  let rest = skeleton;
  for (let index = 0; index < b.tables.length; index += 1) {
    const marker = placeholder(index);
    const at = rest.indexOf(marker);
    if (at === -1 || rest.indexOf(marker, at + 1) !== -1) return null;
    // The table's header is the two lines before its placeholder in the merged text.
    const before = rest.slice(0, at);
    const head = before.split("\n").slice(-3, -1);
    if (head.length !== 2) return null;
    const columns = cells(head[0]!);
    if (!SEPARATOR.test(head[1]!) || cells(head[1]!).length !== columns.length) return null;
    const rows = mergeRows(columns, b.tables[index]!, o.tables[index]!, t.tables[index]!);
    if (!rows) return null;
    parts.push(before, rows.join("\n"));
    rest = rest.slice(at + marker.length);
    // A table with no rows left: drop the placeholder's line break too.
    if (rows.length === 0 && rest.startsWith("\n")) {
      parts[parts.length - 2] = before.replace(/\n$/, "");
    }
  }
  parts.push(rest);
  const text = parts.join("");
  return text.includes(MARKER_PREFIX) ? null : text;
}
