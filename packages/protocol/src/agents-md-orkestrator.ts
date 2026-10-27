/**
 * The `## Orkestrator` section of a repository's root `AGENTS.md`: operating
 * decisions the user approved in a coordinator conversation, which every
 * agent working in the repository reads.
 *
 * A coordinator only proposes entries (`propose_agents_md_update`); the user
 * reviews them in Orkestrator and the backend opens a pull request. This
 * module is the one definition of what a proposal may contain and how it is
 * merged, shared by the backend (which writes the file) and the renderer
 * (which shows the user the resulting diff while they edit), so the diff the
 * user approves is the change the pull request makes.
 *
 * Guarantees:
 * - Everything outside the section is preserved byte for byte. The section is
 *   created at the end of the file when it is missing.
 * - Entries are single-line bullets. Text that could start another Markdown
 *   block (a heading, fence, quote, list, table, HTML or a thematic break),
 *   line breaks, control characters and bidirectional overrides are refused,
 *   so an entry cannot escape the section or hide content.
 * - Entries stay de-duplicated (compared case- and whitespace-insensitively)
 *   and keep their order; additions go after the last existing entry.
 * - Changes are re-applied to whatever the base branch holds when the pull
 *   request is made. An addition already present or a removal already gone
 *   is a no-op; a replacement whose original is gone is a conflict, reported
 *   rather than guessed.
 *
 * Browser-safe: no Node or Bun imports.
 */

export const AGENTS_MD_FILE = "AGENTS.md";
export const ORKESTRATOR_SECTION_TITLE = "Orkestrator";
export const ORKESTRATOR_SECTION_HEADING = `## ${ORKESTRATOR_SECTION_TITLE}`;

/** Written at the top of the section when the backend creates it. */
export const ORKESTRATOR_SECTION_NOTE =
  "Operating decisions the user approved in Orkestrator coordinator conversations. Every agent working in this repository, workers included, must follow them. Agents change this section only through a coordinator proposal that the user approves as a pull request.";

export const MAX_AGENTS_MD_CHANGES = 20;
export const MAX_AGENTS_MD_ENTRY_CHARS = 500;
export const MAX_AGENTS_MD_REASON_CHARS = 500;
export const MAX_ORKESTRATOR_SECTION_ENTRIES = 200;
export const MAX_AGENTS_MD_BYTES = 1024 * 1024;

export type AgentsMdChangeAction = "add" | "replace" | "remove";

export interface AgentsMdChange {
  action: AgentsMdChangeAction;
  /** The entry to add or remove, or the replacement text. One line. */
  text: string;
  /** For `replace`: the existing entry it replaces. */
  replaces?: string;
}

export type AgentsMdErrorCode = "invalid-input" | "conflict" | "ambiguous-section" | "too-large";

export class AgentsMdSectionError extends Error {
  readonly code: AgentsMdErrorCode;
  constructor(code: AgentsMdErrorCode, message: string) {
    super(message);
    this.name = "AgentsMdSectionError";
    this.code = code;
  }
}

// Built from strings so no formatter can turn the escapes into raw characters.
const LINE_BREAK = new RegExp("[\\r\\n\\u000b\\u000c\\u0085\\u2028\\u2029]");
// Tabs are allowed (and collapsed); every other C0/C1 control is refused.
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000e-\\u001f\\u007f-\\u009f]");
// Format characters can hide content or create visually identical entries.
const FORMAT = /\p{Cf}/u;
// Keep the more specific diagnostic for bidirectional overrides and isolates.
const BIDI = new RegExp("[\\u202a-\\u202e\\u2066-\\u2069]");
// What could open another Markdown block when it starts a list item's text.
const BLOCK_START =
  /^(?:#|>|<|\||[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|`{3}|~{3}|={3}|-{3}|_{3}|\*{3})/;
const BULLET_PREFIX = /^[-*+][ \t]+/;

/** Collapse whitespace and drop one leading bullet marker a caller may have typed. */
export function normalizeAgentsMdEntry(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .trim()
    .replace(BULLET_PREFIX, "")
    .trim();
}

/** The comparison key: entries differing only in case, spacing or a final full stop are one. */
export function agentsMdEntryKey(text: string): string {
  return normalizeAgentsMdEntry(text.replace(/\p{Cf}/gu, "").normalize("NFKC"))
    .toLowerCase()
    .replace(/[.;]+$/, "")
    .trim();
}

/** A valid entry, normalized, or an `invalid-input` error naming `field`. */
export function validateAgentsMdEntry(value: unknown, field = "text"): string {
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  if (LINE_BREAK.test(value)) throw invalid(`${field} must be a single line`);
  if (CONTROL.test(value)) throw invalid(`${field} contains control characters`);
  if (BIDI.test(value)) throw invalid(`${field} contains bidirectional control characters`);
  if (FORMAT.test(value)) throw invalid(`${field} contains invisible format characters`);
  const text = normalizeAgentsMdEntry(value);
  if (!text) throw invalid(`${field} is empty`);
  if (text.length > MAX_AGENTS_MD_ENTRY_CHARS)
    throw invalid(`${field} is longer than ${MAX_AGENTS_MD_ENTRY_CHARS} characters`);
  if (BLOCK_START.test(text.normalize("NFKC")))
    throw invalid(
      `${field} must be plain bullet text; it cannot start with a heading, quote, list, fence, table, HTML or rule marker`,
    );
  if (text.includes("<!--") || text.includes("-->"))
    throw invalid(`${field} cannot contain HTML comments`);
  return text;
}

function invalid(message: string): AgentsMdSectionError {
  return new AgentsMdSectionError("invalid-input", message);
}

/**
 * Validate a proposal: 1 to {@link MAX_AGENTS_MD_CHANGES} changes, each one
 * line, no two touching the same entry. Returns normalized copies.
 */
export function parseAgentsMdChanges(value: unknown): AgentsMdChange[] {
  if (!Array.isArray(value) || value.length === 0)
    throw invalid("changes must be a non-empty list");
  if (value.length > MAX_AGENTS_MD_CHANGES)
    throw invalid(`At most ${MAX_AGENTS_MD_CHANGES} changes per proposal`);
  const touched = new Set<string>();
  const changes = value.map((raw, index): AgentsMdChange => {
    const where = `changes[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw invalid(`${where} must be an object`);
    const fields = raw as Record<string, unknown>;
    const unexpected = Object.keys(fields).find(
      (key) => key !== "action" && key !== "text" && key !== "replaces",
    );
    if (unexpected) throw invalid(`${where} has an unexpected field: ${unexpected}`);
    const action = fields.action;
    if (action !== "add" && action !== "replace" && action !== "remove")
      throw invalid(`${where}.action must be add, replace or remove`);
    const text = validateAgentsMdEntry(fields.text, `${where}.text`);
    if (action !== "replace") {
      if (fields.replaces !== undefined)
        throw invalid(`${where}.replaces is only for replace changes`);
      return { action, text };
    }
    const replaces = validateAgentsMdEntry(fields.replaces, `${where}.replaces`);
    if (agentsMdEntryKey(replaces) === agentsMdEntryKey(text))
      throw invalid(`${where} replaces an entry with the same text`);
    return { action, text, replaces };
  });
  for (const [index, change] of changes.entries()) {
    const keys =
      change.action === "replace"
        ? [agentsMdEntryKey(change.replaces!), agentsMdEntryKey(change.text)]
        : [agentsMdEntryKey(change.text)];
    for (const key of keys) {
      if (touched.has(key))
        throw invalid(`changes[${index}] touches an entry another change already touches`);
      touched.add(key);
    }
  }
  return changes;
}

interface Line {
  text: string;
  eol: string;
}

function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ text: content.slice(start), eol: "" });
      break;
    }
    const crlf = newline > start && content[newline - 1] === "\r";
    lines.push({
      text: content.slice(start, crlf ? newline - 1 : newline),
      eol: crlf ? "\r\n" : "\n",
    });
    start = newline + 1;
  }
  return lines;
}

const join = (lines: Line[]) => lines.map((line) => line.text + line.eol).join("");

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** Tracks fenced code blocks so `#` lines inside them are not headings. */
function fenceTracker() {
  let open: string | null = null;
  return (text: string): boolean => {
    const fence = FENCE.exec(text)?.[1];
    if (open) {
      if (
        fence &&
        fence[0] === open[0] &&
        fence.length >= open.length &&
        !/\S/.test(text.trim().slice(fence.length))
      )
        open = null;
      return true;
    }
    if (fence) {
      open = fence;
      return true;
    }
    return false;
  };
}

function heading(text: string): { level: number; title: string } | null {
  const match = HEADING.exec(text);
  if (!match) return null;
  const title = (match[2] ?? "")
    .replace(/[ \t]+#+$/, "")
    .replace(/^#+$/, "")
    .trim();
  return { level: match[1]!.length, title };
}

interface ParsedDocument {
  lines: Line[];
  eol: string;
  /** Index of the `## Orkestrator` heading line, or -1. */
  headingIndex: number;
  /** First line after the section (the next level 1-2 heading), or `lines.length`. */
  endIndex: number;
}

function parseDocument(content: string): ParsedDocument {
  const lines = splitLines(content);
  const eol = lines.find((line) => line.eol)?.eol ?? "\n";
  const inFence = fenceTracker();
  let headingIndex = -1;
  let endIndex = lines.length;
  const plainParagraph = (text: string) =>
    Boolean(text.trim()) &&
    !/^(?: {4}|\t| {0,3}(?:[-*+](?:[ \t]|$)|\d+[.)][ \t]|>|#|`{3}|~{3}|<))/.test(text);
  let paragraphStart = -1;
  for (const [index, line] of lines.entries()) {
    // A BOM belongs to the file bytes, but is not part of the first heading.
    const text = index === 0 ? line.text.replace(/^\uFEFF/, "") : line.text;
    if (inFence(text)) {
      paragraphStart = -1;
      continue;
    }
    const setext = paragraphStart !== -1 && /^ {0,3}(?:=+|-+)[ \t]*$/.test(text);
    const found = setext
      ? {
          level: text.trim().startsWith("=") ? 1 : 2,
          title: lines
            .slice(paragraphStart, index)
            .map((item) => item.text.trim())
            .join(" "),
        }
      : heading(text);
    const start = setext ? paragraphStart : index;
    if (found) paragraphStart = -1;
    else if (plainParagraph(text)) {
      if (paragraphStart === -1) paragraphStart = index;
    } else paragraphStart = -1;
    if (!found || found.level > 2) continue;
    const ours = found.level === 2 && found.title.toLowerCase() === "orkestrator";
    if (ours && setext)
      throw new AgentsMdSectionError(
        "ambiguous-section",
        "Use an ATX ## Orkestrator heading before editing this section.",
      );
    if (ours && headingIndex !== -1)
      throw new AgentsMdSectionError(
        "ambiguous-section",
        "AGENTS.md has more than one ## Orkestrator section; merge them by hand first.",
      );
    if (headingIndex !== -1 && endIndex === lines.length) endIndex = start;
    if (ours) {
      headingIndex = start;
      endIndex = lines.length;
    }
  }
  return { lines, eol, headingIndex, endIndex };
}

type Block =
  | { kind: "text"; lines: Line[] }
  | { kind: "entry"; lines: Line[]; marker: string; key: string; text: string };

const ENTRY = /^([-*+])[ \t]+(.*)$/;
const CONTINUATION_BREAK = /^(?:[-*+][ \t]|\d{1,9}[.)][ \t]|#|>|`{3}|~{3})/;

/** Split a section body into entries (top-level bullets) and everything else. */
function parseBody(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  const inFence = fenceTracker();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fenced = inFence(line.text);
    const entry = fenced ? null : ENTRY.exec(line.text);
    if (!entry) {
      const last = blocks.at(-1);
      if (last?.kind === "text") last.lines.push(line);
      else blocks.push({ kind: "text", lines: [line] });
      index += 1;
      continue;
    }
    const entryLines = [line];
    const parts = [entry[2]!];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]!.text;
      if (!next.trim()) break;
      if (!/^[ \t]/.test(next) && CONTINUATION_BREAK.test(next)) break;
      entryLines.push(lines[index]!);
      parts.push(next.trim());
      index += 1;
    }
    const text = parts
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim();
    blocks.push({
      kind: "entry",
      lines: entryLines,
      marker: entry[1]!,
      key: agentsMdEntryKey(text),
      text,
    });
  }
  return blocks;
}

export interface AgentsMdSection {
  /** Whether the file has a `## Orkestrator` section. */
  exists: boolean;
  /** The section as it appears in the file (heading and body), or null. */
  text: string | null;
  /** The section's entries, in order. */
  entries: string[];
}

/** Read the section from a file's content (null: the file does not exist). */
export function readOrkestratorSection(content: string | null): AgentsMdSection {
  if (content === null) return { exists: false, text: null, entries: [] };
  const document = parseDocument(content);
  if (document.headingIndex === -1) return { exists: false, text: null, entries: [] };
  const sectionLines = document.lines.slice(document.headingIndex, document.endIndex);
  const body = parseBody(sectionLines.slice(1));
  return {
    exists: true,
    text: join(sectionLines),
    entries: body.flatMap((block) => (block.kind === "entry" ? [block.text] : [])),
  };
}

export type AgentsMdChangeResult = "applied" | "already" | "conflict";

export interface AgentsMdChangeOutcome {
  change: AgentsMdChange;
  result: AgentsMdChangeResult;
  detail?: string;
}

export interface AgentsMdMergeResult {
  /** The whole new file; the original content when nothing changed or on conflict. */
  content: string;
  changed: boolean;
  /** The section did not exist and was added at the end of the file. */
  createdSection: boolean;
  createdFile: boolean;
  outcomes: AgentsMdChangeOutcome[];
  conflicts: AgentsMdChangeOutcome[];
  /** The section before and after, for review (`null`: there was none). */
  sectionBefore: string | null;
  sectionAfter: string | null;
  entriesAfter: string[];
}

/**
 * Apply `changes` to `content` (null: no AGENTS.md yet). Only the
 * `## Orkestrator` section changes; the rest of the file is copied byte for
 * byte. On any conflict nothing is applied and `conflicts` says why.
 */
export function mergeOrkestratorSection(
  content: string | null,
  changes: readonly AgentsMdChange[],
): AgentsMdMergeResult {
  const original = content ?? "";
  if (original.length > MAX_AGENTS_MD_BYTES)
    throw new AgentsMdSectionError("too-large", "AGENTS.md is larger than 1 MiB.");
  const document = parseDocument(original);
  const { lines, eol } = document;
  const exists = document.headingIndex !== -1;
  const sectionLines = exists ? lines.slice(document.headingIndex, document.endIndex) : [];
  const blocks = exists ? parseBody(sectionLines.slice(1)) : [];
  const entries = blocks.filter(
    (block): block is Extract<Block, { kind: "entry" }> => block.kind === "entry",
  );
  const present = new Set(entries.map((block) => block.key));

  const outcomes: AgentsMdChangeOutcome[] = changes.map((change) => {
    const key = agentsMdEntryKey(change.text);
    if (change.action === "add")
      return present.has(key)
        ? { change, result: "already", detail: "Already in the section." }
        : { change, result: "applied" };
    if (change.action === "remove")
      return present.has(key)
        ? { change, result: "applied" }
        : { change, result: "already", detail: "Already absent from the section." };
    if (present.has(agentsMdEntryKey(change.replaces!))) return { change, result: "applied" };
    return present.has(key)
      ? { change, result: "already", detail: "The replacement is already in the section." }
      : {
          change,
          result: "conflict",
          detail: `The entry to replace is no longer in the section: “${change.replaces}”.`,
        };
  });
  const conflicts = outcomes.filter((outcome) => outcome.result === "conflict");
  const applied = outcomes.filter((outcome) => outcome.result === "applied");
  const sectionBefore = exists ? join(sectionLines) : null;
  const unchanged = (): AgentsMdMergeResult => ({
    content: original,
    changed: false,
    createdSection: false,
    createdFile: false,
    outcomes,
    conflicts,
    sectionBefore,
    sectionAfter: sectionBefore,
    entriesAfter: entries.map((block) => block.text),
  });
  if (conflicts.length > 0 || applied.length === 0) return unchanged();

  const removed = new Set(
    applied
      .filter((outcome) => outcome.change.action === "remove")
      .map((outcome) => agentsMdEntryKey(outcome.change.text)),
  );
  const replaced = new Map(
    applied
      .filter((outcome) => outcome.change.action === "replace")
      .map((outcome) => [agentsMdEntryKey(outcome.change.replaces!), outcome.change.text]),
  );
  const added = applied
    .filter((outcome) => outcome.change.action === "add")
    .map((outcome) => outcome.change.text);

  const bullet = (marker: string, text: string): Line => ({ text: `${marker} ${text}`, eol });
  const marker = entries[0]?.marker ?? "-";
  const seen = new Set<string>();
  const bodyOut: Line[] = [];
  let afterLastEntry = -1;
  for (const block of blocks) {
    if (block.kind === "text") {
      bodyOut.push(...block.lines);
      continue;
    }
    if (removed.has(block.key)) continue;
    const replacement = replaced.get(block.key);
    const key = replacement === undefined ? block.key : agentsMdEntryKey(replacement);
    if (seen.has(key)) continue;
    seen.add(key);
    if (replacement === undefined) bodyOut.push(...block.lines);
    else bodyOut.push(bullet(block.marker, replacement));
    afterLastEntry = bodyOut.length;
  }
  const additions = added
    .filter((text) => !seen.has(agentsMdEntryKey(text)))
    .map((text) => {
      seen.add(agentsMdEntryKey(text));
      return bullet(marker, text);
    });
  if (seen.size > MAX_ORKESTRATOR_SECTION_ENTRIES)
    throw new AgentsMdSectionError(
      "too-large",
      `The section would hold more than ${MAX_ORKESTRATOR_SECTION_ENTRIES} entries.`,
    );

  let headingLine: Line;
  let body: Line[];
  if (exists) {
    headingLine = { ...sectionLines[0]! };
    body = bodyOut;
    if (additions.length > 0) {
      if (afterLastEntry === -1) {
        // No entries yet: after the body's content, before its trailing blank lines.
        let insertAt = body.length;
        while (insertAt > 0 && !body[insertAt - 1]!.text.trim()) insertAt -= 1;
        // A blank line between the heading or preamble and the new list.
        body = [
          ...body.slice(0, insertAt),
          { text: "", eol },
          ...additions,
          ...body.slice(insertAt),
        ];
      } else {
        body = [...body.slice(0, afterLastEntry), ...additions, ...body.slice(afterLastEntry)];
      }
    }
  } else {
    headingLine = { text: ORKESTRATOR_SECTION_HEADING, eol };
    body = [
      { text: "", eol },
      { text: ORKESTRATOR_SECTION_NOTE, eol },
      { text: "", eol },
      ...additions,
    ];
  }
  // Every line ends with a newline: the original's last line may not have, and
  // an entry now follows it (a file ending without one gains it).
  const section = [headingLine, ...body].map((line) => (line.eol ? line : { ...line, eol }));
  if (exists && document.endIndex < lines.length) {
    // Keep the blank line before the next heading the original had, if any.
    const hadGap = !sectionLines.at(-1)!.text.trim();
    if (hadGap && section.at(-1)!.text.trim()) section.push({ text: "", eol });
  }

  let before: string;
  let after: string;
  if (exists) {
    before = join(lines.slice(0, document.headingIndex));
    after = join(lines.slice(document.endIndex));
  } else {
    before = original;
    if (before && !before.endsWith("\n")) before += eol;
    if (before.trim() && !before.endsWith(`${eol}${eol}`) && !before.endsWith("\n\n"))
      before += eol;
    after = "";
  }
  const sectionAfter = join(section);
  const next = before + sectionAfter + after;
  // Defence in depth: the bytes outside the section are the original's.
  const prefix = exists ? join(lines.slice(0, document.headingIndex)) : original;
  if (!next.startsWith(prefix) || !next.endsWith(after))
    throw new AgentsMdSectionError(
      "conflict",
      "The change would alter AGENTS.md outside the section.",
    );
  if (next.length > MAX_AGENTS_MD_BYTES)
    throw new AgentsMdSectionError("too-large", "AGENTS.md would be larger than 1 MiB.");
  return {
    content: next,
    changed: next !== original || content === null,
    createdSection: !exists,
    createdFile: content === null,
    outcomes,
    conflicts,
    sectionBefore,
    sectionAfter,
    entriesAfter: parseBody(section.slice(1)).flatMap((block) =>
      block.kind === "entry" ? [block.text] : [],
    ),
  };
}

export type AgentsMdDiffLine = { type: "same" | "add" | "remove"; text: string };

const MAX_DIFF_CELLS = 400_000;

/** A line diff for review. Falls back to remove-all/add-all beyond a size bound. */
export function diffAgentsMdLines(before: string, after: string): AgentsMdDiffLine[] {
  const a = splitLines(before).map((line) => line.text);
  const b = splitLines(after).map((line) => line.text);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head = a.slice(0, start).map((text) => ({ type: "same" as const, text }));
  const tail = a.slice(endA).map((text) => ({ type: "same" as const, text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let middle: AgentsMdDiffLine[];
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    middle = [
      ...midA.map((text) => ({ type: "remove" as const, text })),
      ...midB.map((text) => ({ type: "add" as const, text })),
    ];
  } else {
    // Longest common subsequence, walked from the start.
    const rows = midA.length + 1;
    const cols = midB.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = midA.length - 1; i >= 0; i -= 1)
      for (let j = midB.length - 1; j >= 0; j -= 1)
        table[i * cols + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * cols + j + 1]! + 1
            : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    middle = [];
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        middle.push({ type: "same", text: midA[i]! });
        i += 1;
        j += 1;
      } else if (
        j < midB.length &&
        (i === midA.length || table[i * cols + j + 1]! >= table[(i + 1) * cols + j]!)
      ) {
        middle.push({ type: "add", text: midB[j]! });
        j += 1;
      } else {
        middle.push({ type: "remove", text: midA[i]! });
        i += 1;
      }
    }
  }
  return [...head, ...middle, ...tail];
}

/** One line per change, for the pull request body, the commit and the user. */
export function describeAgentsMdChange(change: AgentsMdChange): string {
  if (change.action === "add") return `Add: ${change.text}`;
  if (change.action === "remove") return `Remove: ${change.text}`;
  return `Replace: “${change.replaces}” → “${change.text}”`;
}

/**
 * What a main coordinator is told every turn about saving decisions. Kept
 * short because it is injected on every turn.
 */
export const COORDINATOR_AGENTS_MD_RULE =
  "Decisions: when the user settles a durable decision, rule or preference that future workers or conversations should follow (how workers behave, safety rules, conventions), ask once, briefly, at a natural pause after it is agreed, whether to save it to the ## Orkestrator section of AGENTS.md; batch several decisions into one question and one propose_agents_md_update call. You write nothing: the user reviews the change and Orkestrator opens a pull request. Skip one-off task details, and do not ask again about a decision the user declined in this conversation unless they raise it.";
