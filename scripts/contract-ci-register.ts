/**
 * The compatibility register in `docs/architecture/version-compatibility.md`
 * read as data, for the contract CI job (plan item 1008,
 * docs/reports/unified-federation.md §11.3 steps 3 and 5).
 *
 * - **Register rows** are the table rows under `## Register` up to
 *   `### Retired`: `Path | Where | Counter | Serves | Retire when | Owner`.
 * - **Retired rows** are the rows under `### Retired`: `Path | Retired | Why
 *   it could go`. A command that was removed may be named in either table.
 *
 * A row *names* something when it holds it as a code span (`` `name` ``).
 * Counter ids are the dotted lowercase code spans of the Counter cell
 * (`bridge-transcript.messages-fallback`); a cell that starts with "None"
 * has no counter. A domain adapter's row names its counter id,
 * `domain-adapter.<backend|renderer>.<domain>.v<version>`, anywhere in the row.
 *
 * Only Node built-ins and the browser-safe protocol module are imported, so
 * the root suite can run it without loading the registry.
 */
import { isDomainAdapterPathId } from "@orkestrator/protocol/contract/client-usage";

/** The register's document, relative to the repository root. */
export const REGISTER_DOCUMENT = "docs/architecture/version-compatibility.md";

/** The register table's columns, in order. */
export const REGISTER_COLUMNS = ["Path", "Where", "Counter", "Serves", "Retire when", "Owner"];
const COUNTER_COLUMN = 2;

export interface RegisterRow {
  readonly table: "register" | "retired";
  /** 1-based line in the document. */
  readonly line: number;
  readonly cells: readonly string[];
  /** Every code span in the row, without the backticks. */
  readonly names: ReadonlySet<string>;
}

export interface RegisterDocument {
  readonly register: readonly RegisterRow[];
  readonly retired: readonly RegisterRow[];
  /** Rows that do not have the register's six cells. */
  readonly malformed: readonly RegisterRow[];
}

/** A counter id: dotted lowercase words (`history.joined-v1-page.unpaged-source`). */
const COUNTER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;
/** File names in a Counter cell are not ids (`compatibility-path-usage.ts`). */
const FILE_EXTENSION_PATTERN = /\.(?:ts|tsx|js|json|md|sh|toml|yml|yaml)$/u;
const DOMAIN_ADAPTER_ID_PATTERN =
  /^domain-adapter\.(backend|renderer)\.([a-z][a-z0-9-]*)\.v(\d+)$/u;

function splitCells(line: string): string[] {
  const body = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index++;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!.trim());
}

/** Reads the register and retired tables from the document's text. */
export function parseRegisterDocument(markdown: string): RegisterDocument {
  const register: RegisterRow[] = [];
  const retired: RegisterRow[] = [];
  const malformed: RegisterRow[] = [];
  let table: RegisterRow["table"] | null = null;
  markdown.split("\n").forEach((text, index) => {
    const heading = /^(#{1,6})\s+(.*)$/u.exec(text);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      if (level === 2) table = title === "Register" ? "register" : null;
      else if (level === 3 && table !== null) table = title === "Retired" ? "retired" : "register";
      return;
    }
    if (table === null || !text.trimStart().startsWith("|")) return;
    const cells = splitCells(text);
    if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) return;
    if (cells[0] === "Path") return;
    const row: RegisterRow = {
      table,
      line: index + 1,
      cells,
      names: new Set(cells.flatMap(codeSpans)),
    };
    if (table === "register") {
      register.push(row);
      if (cells.length !== REGISTER_COLUMNS.length) malformed.push(row);
    } else {
      retired.push(row);
    }
  });
  return { register, retired, malformed };
}

/** The counter ids a register row's Counter cell names; `null` when the cell says there is none. */
export function rowCounterIds(row: RegisterRow): string[] | null {
  const cell = row.cells[COUNTER_COLUMN] ?? "";
  if (/^none\b/iu.test(cell) || cell === "" || cell === "—" || cell === "-") return null;
  return codeSpans(cell).filter(
    (span) => COUNTER_ID_PATTERN.test(span) && !FILE_EXTENSION_PATTERN.test(span),
  );
}

/** A domain adapter a register row names by its counter id. */
export interface RowAdapter {
  readonly domain: string;
  readonly version: number;
  readonly id: string;
}

/** The domain adapters a row names (`domain-adapter.<side>.<domain>.v<version>`). */
export function rowAdapters(row: RegisterRow): RowAdapter[] {
  const adapters: RowAdapter[] = [];
  for (const name of row.names) {
    const match = DOMAIN_ADAPTER_ID_PATTERN.exec(name);
    if (match) adapters.push({ domain: match[2]!, version: Number(match[3]), id: name });
  }
  return adapters;
}

function describeRow(row: RegisterRow): string {
  const path = row.cells[0] ?? "";
  const short = path.length > 80 ? `${path.slice(0, 77)}...` : path;
  return `${REGISTER_DOCUMENT}:${row.line} (${short})`;
}

/**
 * Register rows whose Counter cell names no known counter id, or an id that
 * is neither in `COMPATIBILITY_PATH_IDS` nor a well-formed domain adapter id.
 */
export function checkRegisterCounters(
  document: RegisterDocument,
  knownIds: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const row of document.malformed) {
    problems.push(
      `${describeRow(row)} has ${row.cells.length} cells; a register row has ${REGISTER_COLUMNS.length} (${REGISTER_COLUMNS.join(" | ")}).`,
    );
  }
  for (const row of document.register) {
    const ids = rowCounterIds(row);
    if (ids === null) continue;
    if (ids.length === 0) {
      problems.push(
        `${describeRow(row)} has a counter but names no counter id: write the id from COMPATIBILITY_PATH_IDS as a code span, or "None (...)".`,
      );
      continue;
    }
    for (const id of ids) {
      if (!knownIds.has(id) && !isDomainAdapterPathId(id)) {
        problems.push(
          `${describeRow(row)} names counter \`${id}\`, which is not in COMPATIBILITY_PATH_IDS (apps/backend/src/core/compatibility-path-usage.ts).`,
        );
      }
    }
  }
  return problems;
}
