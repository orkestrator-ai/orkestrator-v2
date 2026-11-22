/**
 * A three-way merge for the repository's Markdown index tables
 * (`docs/todo/**\/0000-index.md`, `docs/tests/flaky-tests/**\/0000-index.md`).
 *
 * Every branch that adds a to-do or a flake case appends a row to the same
 * table, so two such branches always conflict on Git's line merge: both
 * insert after the same last row. The rows are records, not lines of prose,
 * so this merge treats them as records:
 *
 * - each row is keyed by the first Markdown link in it (the file it indexes),
 *   or by its first cell when it has none;
 * - a row changed on one side only takes that side's version, a row added on
 *   either side is kept, and a row removed on one side is removed unless the
 *   other side changed it;
 * - a `Rank` column is renumbered 1..n after the merge (ranks are positions,
 *   and both sides appending "rank 25" is not a conflict), and an `ID` table
 *   stays in ID order.
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
  /** Header and separator lines, kept with the surrounding text. */
  readonly head: readonly string[];
  readonly rows: readonly string[];
}

interface Parsed {
  /** The text with each table's rows replaced by one placeholder line. */
  readonly skeleton: string;
  readonly tables: readonly Table[];
}

const PLACEHOLDER = (index: number) => `\u0000orkestrator-index-table-${index}\u0000`;
const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;
const RANK_CELL = /^\|\s*\d+\s*\|/;
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
      while (cursor < lines.length && isTableLine(lines[cursor]!)) {
        rows.push(lines[cursor]!);
        cursor += 1;
      }
      out.push(line, next, PLACEHOLDER(tables.length));
      tables.push({ head: [line, next], rows });
      index = cursor - 1;
      continue;
    }
    out.push(line);
  }
  return { skeleton: out.join("\n"), tables };
}

function firstCell(row: string): string {
  return row.split("|")[1]?.trim() ?? "";
}

function rowKey(row: string): string {
  return row.match(LINK)?.[1] ?? firstCell(row);
}

/** Keyed rows in order, or null when a key repeats. */
function keyed(rows: readonly string[]): Map<string, string> | null {
  const map = new Map<string, string>();
  for (const row of rows) {
    const key = rowKey(row);
    if (map.has(key)) return null;
    map.set(key, row);
  }
  return map;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function mergeRows(
  head: readonly string[],
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): string[] | null {
  const ranked = firstCell(head[0]!) === "Rank";
  const ordered = firstCell(head[0]!) === "ID";
  const comparable = (row: string | undefined) =>
    row === undefined || !ranked ? row : row.replace(RANK_CELL, "| # |");

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
  if (ordered) {
    rows = rows
      .map((row, index) => ({ row, index, id: Number(firstCell(row)) }))
      .sort((left, right) =>
        Number.isFinite(left.id) && Number.isFinite(right.id) && left.id !== right.id
          ? left.id - right.id
          : left.index - right.index,
      )
      .map(({ row }) => row);
  }
  if (ranked) rows = rows.map((row, index) => row.replace(RANK_CELL, `| ${index + 1} |`));
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
    const marker = PLACEHOLDER(index);
    const at = rest.indexOf(marker);
    if (at === -1 || rest.indexOf(marker, at + 1) !== -1) return null;
    // The table's header is the two lines before its placeholder in the merged text.
    const before = rest.slice(0, at);
    const head = before.split("\n").slice(-3, -1);
    if (head.length !== 2) return null;
    const rows = mergeRows(
      head,
      b.tables[index]!.rows,
      o.tables[index]!.rows,
      t.tables[index]!.rows,
    );
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
  return text.includes("\u0000") ? null : text;
}
