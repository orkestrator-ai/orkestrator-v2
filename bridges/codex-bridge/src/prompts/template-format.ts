/**
 * Prompt-template file format: frontmatter, summaries, executable-span
 * detection and `$ARGUMENTS` expansion. Pure — no I/O.
 *
 * Project (`<cwd>/.codex/prompts`) and user (`$CODEX_HOME/prompts`) prompt
 * files are an Orkestrator-owned compatibility feature, not a Codex runtime
 * surface. The format supported here is deliberately small:
 *
 * - Frontmatter is a `---` fenced block of single-line `key: value` fields.
 *   It is not YAML: block scalars, indented continuations of a recognised key
 *   and bare lines are rejected with an explanation instead of being guessed.
 *   Indented lines under an *unrecognised* key (for example an
 *   `allowed-tools:` list written for another tool) are ignored.
 * - `$ARGUMENTS` is the only substitution. Positional and named arguments are
 *   not supported and are left as literal text.
 * - Inline shell (`!` followed by a backtick span) is never executed. A
 *   template containing one is reported unavailable.
 */
import { truncateUtf8, utf8ByteLength } from "@orkestrator/protocol/agent-command-catalogue";

export const TEMPLATE_DESCRIPTION_MAX_BYTES = 1_000;
export const TEMPLATE_ARGUMENT_HINT_MAX_BYTES = 512;

/** Keys this parser understands. Everything else is ignored. */
const RECOGNISED_KEYS = new Set([
  "description",
  "short_description",
  "argument-hint",
  "argument_hint",
  "arguments",
]);

const BLOCK_SCALAR = /^[|>][+-]?\d*$/;
const FIELD_LINE = /^([A-Za-z0-9_.-]+)[ \t]*:(?:[ \t]+(.*))?$/;

export interface ParsedTemplate {
  body: string;
  fields: Record<string, string>;
  /** Set when the frontmatter cannot be read predictably. */
  error?: string;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.at(-1) === first) return value.slice(1, -1);
  }
  return value;
}

/**
 * Split an optional frontmatter block from a template.
 *
 * A file that does not start with a `---` line has no frontmatter and is all
 * body. A file that opens a block but never closes it is malformed rather
 * than silently becoming body text, because sending the metadata to the model
 * as the prompt is exactly the surprise a template author would not expect.
 */
export function extractFrontmatter(content: string): ParsedTemplate {
  // A leading byte-order mark (U+FEFF) is not part of the fence.
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const firstBreak = text.indexOf("\n");
  const firstLine = (firstBreak === -1 ? text : text.slice(0, firstBreak)).replace(/\r$/, "");
  if (firstLine.trimEnd() !== "---") return { body: text, fields: {} };

  const fields: Record<string, string> = {};
  let cursor = firstBreak === -1 ? text.length : firstBreak + 1;
  let previousKey: string | undefined;
  let error: string | undefined;
  while (cursor < text.length) {
    const lineEnd = text.indexOf("\n", cursor);
    const next = lineEnd === -1 ? text.length : lineEnd + 1;
    const line = text.slice(cursor, lineEnd === -1 ? text.length : lineEnd).replace(/\r$/, "");
    cursor = next;
    if (line.trimEnd() === "---") {
      return error
        ? { body: text.slice(cursor), fields: {}, error }
        : { body: text.slice(cursor), fields };
    }
    if (error) continue;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^[ \t]/.test(line)) {
      if (previousKey && RECOGNISED_KEYS.has(previousKey)) {
        error = `The ${previousKey} field spans several lines; use a single line.`;
      }
      continue;
    }
    const match = FIELD_LINE.exec(line);
    if (!match) {
      error = "The frontmatter has a line that is not `key: value`.";
      continue;
    }
    const key = match[1]!;
    const value = (match[2] ?? "").trim();
    previousKey = key;
    if (!RECOGNISED_KEYS.has(key)) continue;
    if (BLOCK_SCALAR.test(value)) {
      error = `The ${key} field uses a YAML block; use a single line.`;
      continue;
    }
    // First spelling wins, so a later duplicate cannot silently replace it.
    if (!(key in fields)) fields[key] = unquote(value);
  }
  return { body: text, fields: {}, error: "The frontmatter is not closed with a --- line." };
}

/** First meaningful line, used when a template has no description field. */
export function summarizePromptTemplate(content: string): string | undefined {
  const taskSectionMatch = content.match(/##\s+Your Task\s*\n+([\s\S]+)/i);
  const candidateBlock = taskSectionMatch ? taskSectionMatch[1] : content;
  const line = candidateBlock
    ?.split("\n")
    .map((entry) => entry.trim())
    .find(
      (entry) =>
        entry.length > 0 &&
        !entry.startsWith("#") &&
        !entry.startsWith("- Current") &&
        !entry.includes("$ARGUMENTS"),
    );

  return line ? line.replace(/\s+/g, " ").trim() : undefined;
}

export interface TemplateMetadata {
  description?: string;
  argumentHint?: string;
}

/**
 * Display metadata from parsed fields.
 *
 * Argument hint precedence: `argument-hint` (the common spelling), then the
 * legacy `argument_hint`, then `arguments`.
 */
export function templateMetadata(parsed: ParsedTemplate, fallbackName: string): TemplateMetadata {
  const { fields } = parsed;
  const description =
    fields.description ||
    fields.short_description ||
    summarizePromptTemplate(parsed.body) ||
    `Run ${fallbackName} prompt`;
  const hint = fields["argument-hint"] || fields.argument_hint || fields.arguments;
  return {
    description: truncateUtf8(description, TEMPLATE_DESCRIPTION_MAX_BYTES),
    ...(hint ? { argumentHint: truncateUtf8(hint, TEMPLATE_ARGUMENT_HINT_MAX_BYTES) } : {}),
  };
}

/** The span syntax the retired executor ran: `!` then a backtick span. */
const EXECUTABLE_SPAN = /!`[^`]+`/;

/**
 * Whether the template text itself asks for shell execution.
 *
 * Always evaluated on the *original* template body, never on expanded text,
 * so argument text cannot create (or hide) an executable span.
 */
export function templateRequiresShell(body: string): boolean {
  return EXECUTABLE_SPAN.test(body);
}

export const SHELL_TEMPLATE_MESSAGE =
  "This prompt runs inline shell commands (!`…`), which Orkestrator no longer executes. " +
  "Remove the shell spans or paste their output into the prompt.";

const ARGUMENTS_TOKEN = "$ARGUMENTS";

export type TemplateExpansion = { ok: true; text: string } | { ok: false; message: string };

/**
 * Substitute `$ARGUMENTS` with the verbatim argument suffix.
 *
 * Refuses before building a string larger than `maxBytes`, so a short body
 * repeating the token cannot be multiplied by a large argument into an
 * unbounded allocation. Uses split/join rather than `replaceAll`, whose string
 * replacement interprets `$&` and friends inside the user's arguments.
 */
export function expandTemplateArguments(
  body: string,
  args: string,
  maxBytes: number,
): TemplateExpansion {
  if (templateRequiresShell(body)) return { ok: false, message: SHELL_TEMPLATE_MESSAGE };
  const pieces = body.split(ARGUMENTS_TOKEN);
  const occurrences = pieces.length - 1;
  const projected =
    utf8ByteLength(body) -
    occurrences * ARGUMENTS_TOKEN.length +
    occurrences * utf8ByteLength(args);
  if (projected > maxBytes) {
    return {
      ok: false,
      message: `The expanded prompt would exceed ${Math.floor(maxBytes / 1024)} KiB. Shorten the arguments or the template.`,
    };
  }
  return { ok: true, text: pieces.join(args) };
}
