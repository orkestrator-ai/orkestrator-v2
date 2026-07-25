#!/usr/bin/env bun
/**
 * Scrubs a recorded app-server stream so it can be committed as a replay fixture.
 *
 * A raw recording is a faithful copy of a real session: your prompts, the contents
 * of every file the agent read or wrote, absolute paths that leak your username,
 * and anything a tool happened to print — including tokens and keys.
 *
 * **This is a safety net, not a guarantee.** It cannot recognise a secret it has
 * no pattern for. Always read the diff before committing a fixture.
 *
 * Usage:
 *   bun scripts/scrub-codex-recording.ts <input.jsonl> [output.jsonl] [flags]
 *
 * Flags:
 *   --check            Write nothing. Prints a per-method record census and
 *                      exits non-zero if anything would still be redacted.
 *                      `tests/unit/scrub-codex-recording.test.ts` runs the same
 *                      `scrub()` over every committed fixture, which is what
 *                      actually rejects an unscrubbed one.
 *   --home=<path>      Home directory to redact instead of this machine's.
 *   --user=<name>      Username to redact instead of this machine's.
 *   --strip-content    Also blank the payload fields — `delta`, `text`,
 *                      `aggregatedOutput`, `diff`. Identity and secret patterns
 *                      cannot cover prose, so this is the only way to be sure a
 *                      fixture carries no prompt or file content at all. It
 *                      keeps the record *shapes*, which is what a replay test
 *                      exercises.
 *
 * `--home` / `--user` matter because identity redaction otherwise keys off the
 * machine doing the scrubbing: a recording produced in the container (every path
 * under `/home/node`) or by a colleague matches neither. The generic
 * home-shaped-path rule covers that case regardless of who made the recording.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

const REDACTED = "«redacted»";

export interface Redaction {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/** Identity to redact. Defaults to the machine running the scrubber. */
export interface ScrubIdentity {
  home?: string;
  user?: string;
}

/**
 * Ordered most-specific first: a key pattern must win before the generic
 * long-token pattern gets a chance to mangle it into something unrecognisable.
 */
export function buildRedactions(identity: ScrubIdentity = {}): Redaction[] {
  const home = identity.home?.trim() || homedir();
  const user = identity.user?.trim() || basename(home);

  return [
    // Provider keys. Prefixes are stable enough to match on directly.
    // `sk-ant-` must precede `sk-`, or the broader pattern consumes it first and
    // the Anthropic rule never fires (still redacted, but mislabelled in the
    // report — which matters when you are reading the diff to decide if it is safe).
    { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replacement: "sk-ant-«redacted»" },
    { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: "sk-«redacted»" },
    { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: "ghp_«redacted»" },
    { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "AKIA«redacted»" },
    { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: "xoxb-«redacted»" },
    { name: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "AIza«redacted»" },
    { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, replacement: `Bearer ${REDACTED}` },
    { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
    // PEM blocks, which JSON-escape to a single line with \n sequences.
    {
      name: "private-key",
      pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      replacement: `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
    },
    // `KEY=value` / `"token": "value"` shapes, which catch the long tail.
    {
      name: "env-assignment",
      pattern: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*[^\s"',;]{6,}/g,
      replacement: `$1=${REDACTED}`,
    },
    {
      name: "json-secret-field",
      pattern: /("(?:[a-zA-Z_]*(?:secret|token|password|apiKey|api_key|credential|authorization)[a-zA-Z_]*)"\s*:\s*")[^"]{6,}(")/gi,
      replacement: `$1${REDACTED}$2`,
    },
    // Identity. Home first, so the more specific path wins over the bare username.
    { name: "home-path", pattern: new RegExp(escapeRegExp(home), "g"), replacement: "/home/user" },
    // `user` is the placeholder this script writes, so redacting it would report
    // hits forever on a file it had already cleaned.
    ...(user === "user"
      ? []
      : [{
        name: "username",
        pattern: new RegExp(`\\b${escapeRegExp(user)}\\b`, "g"),
        replacement: "user",
      }]),
    // Any home-shaped path, whoever it belongs to. The two rules above key off
    // the *scrubbing* machine, so a recording made in the container (everything
    // under /home/node) or by another developer would otherwise sail through
    // `--check` reported as clean.
    {
      name: "home-like-path",
      pattern: /\/(?:Users|home)\/(?!user\b)[^/\s"\\]+/g,
      replacement: "/home/user",
    },
    // The negative lookaheads on these two keep the pass idempotent: their own
    // replacements match their own patterns, so without them re-checking an
    // already-scrubbed fixture would report hits forever.
    {
      name: "email",
      pattern: /\b(?!user@example\.com\b)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      replacement: "user@example.com",
    },
    // Private-range IPs, which identify an internal network.
    {
      name: "private-ip",
      pattern: /\b(?!10\.0\.0\.1\b)(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
      replacement: "10.0.0.1",
    },
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ScrubResult {
  output: string;
  /** Redaction name → number of substitutions. */
  hits: Record<string, number>;
  totalHits: number;
}

export function scrub(input: string, redactions: Redaction[] = buildRedactions()): ScrubResult {
  let output = input;
  const hits: Record<string, number> = {};
  let totalHits = 0;

  for (const redaction of redactions) {
    let count = 0;
    output = output.replace(redaction.pattern, (...args: unknown[]) => {
      count += 1;
      // Re-run the replacement string's $n expansion by hand: we are inside a
      // function replacer, so `$1` would otherwise be taken literally.
      return expandReplacement(redaction.replacement, args);
    });
    if (count > 0) {
      hits[redaction.name] = count;
      totalHits += count;
    }
  }

  return { output, hits, totalHits };
}

function expandReplacement(template: string, matchArgs: unknown[]): string {
  return template.replace(/\$(\d)/g, (_marker, digit: string) => {
    const group = matchArgs[Number(digit)];
    return typeof group === "string" ? group : "";
  });
}

/**
 * The fields a recording is actually made of. Every redaction above is a
 * secret or identity pattern; none of them touch the model's prose, the shell
 * output or the patches — which per the recorder's own docs is the bulk of what
 * a raw recording contains.
 */
export const CONTENT_FIELDS = ["delta", "text", "aggregatedOutput", "diff"] as const;

function blankValue(value: unknown, onBlank: () => void): unknown {
  if (typeof value === "string") {
    if (value.length > 0) onBlank();
    return "";
  }
  if (Array.isArray(value)) return value.map((entry) => blankValue(entry, onBlank));
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) result[key] = blankValue(entry, onBlank);
    return result;
  }
  return value;
}

function stripValue(value: unknown, onBlank: () => void): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripValue(entry, onBlank));
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      result[key] = (CONTENT_FIELDS as readonly string[]).includes(key)
        ? blankValue(entry, onBlank)
        : stripValue(entry, onBlank);
    }
    return result;
  }
  return value;
}

/**
 * Blanks every payload field while keeping the record *shape* — which is all a
 * replay fixture exercises. Unparseable lines are passed through untouched so
 * the pipeline never turns a malformed line into a differently malformed one.
 */
export function stripContent(input: string): { output: string; stripped: number } {
  let stripped = 0;
  const onBlank = () => {
    stripped += 1;
  };
  const lines = input.split("\n").map((line) => {
    if (line.trim().length === 0) return line;
    try {
      return JSON.stringify(stripValue(JSON.parse(line), onBlank));
    } catch {
      return line;
    }
  });
  return { output: lines.join("\n"), stripped };
}

/** Record kind → count, for the `--check` census. */
export function censusByMethod(input: string): Record<string, number> {
  const census: Record<string, number> = {};
  for (const line of input.split("\n")) {
    if (line.trim().length === 0) continue;
    let key = "«unparseable»";
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (typeof record.method === "string") key = record.method;
      else if ("error" in record) key = "«error response»";
      else if ("result" in record) key = "«result response»";
      else key = "«unknown shape»";
    } catch {
      // Keep the default.
    }
    census[key] = (census[key] ?? 0) + 1;
  }
  return census;
}

/**
 * Verifies the scrubbed text is still parseable JSONL.
 *
 * A redaction that lands inside a JSON string is safe, but one that eats a quote
 * would produce a fixture the replay harness silently counts as `invalidLines`.
 */
function validateJsonl(text: string): { lines: number; invalid: number } {
  let lines = 0;
  let invalid = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    lines += 1;
    try {
      JSON.parse(line);
    } catch {
      invalid += 1;
    }
  }
  return { lines, invalid };
}

const USAGE = "usage: bun scripts/scrub-codex-recording.ts <input.jsonl> [output.jsonl] "
  + "[--check] [--strip-content] [--home=<path>] [--user=<name>]";

export interface ScrubArguments {
  inputPath: string;
  outputPath: string;
  check: boolean;
  stripContent: boolean;
  identity: ScrubIdentity;
}

export function parseArguments(args: string[]): ScrubArguments {
  const positional: string[] = [];
  const parsed: ScrubArguments = {
    inputPath: "",
    outputPath: "",
    check: false,
    stripContent: false,
    identity: {},
  };
  for (const argument of args) {
    if (!argument.startsWith("--")) {
      positional.push(argument);
    } else if (argument === "--check") {
      parsed.check = true;
    } else if (argument === "--strip-content") {
      parsed.stripContent = true;
    } else if (argument.startsWith("--home=")) {
      parsed.identity.home = argument.slice("--home=".length);
    } else if (argument.startsWith("--user=")) {
      parsed.identity.user = argument.slice("--user=".length);
    } else {
      throw new Error(`Unknown flag ${argument}\n${USAGE}`);
    }
  }
  if (positional.length === 0 || positional.length > 2) throw new Error(USAGE);
  parsed.inputPath = positional[0]!;
  // In-place by default, which is what the record-then-commit workflow wants.
  parsed.outputPath = positional[1] ?? positional[0]!;
  return parsed;
}

async function main(): Promise<void> {
  let args: ScrubArguments;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const input = readFileSync(args.inputPath, "utf8");
  const census = censusByMethod(input);
  const stripped = args.stripContent ? stripContent(input) : { output: input, stripped: 0 };
  const result = scrub(stripped.output, buildRedactions(args.identity));
  const validation = validateJsonl(result.output);

  console.log(`Read ${validation.lines} JSONL records from ${args.inputPath}`);
  if (args.stripContent) {
    console.log(
      `Blanked ${stripped.stripped} content field(s) (${CONTENT_FIELDS.join(", ")}).`,
    );
  }
  if (result.totalHits === 0) {
    console.log("No redactions matched.");
  } else {
    console.log(`Redacted ${result.totalHits} match(es):`);
    for (const [name, count] of Object.entries(result.hits).sort()) {
      console.log(`  ${name.padEnd(20)} ${count}`);
    }
  }
  if (validation.invalid > 0) {
    console.error(
      `\nERROR: ${validation.invalid} record(s) are no longer valid JSON after scrubbing.`,
    );
    process.exit(1);
  }

  if (args.check) {
    // A census, not a bare "clean": the redaction rules cannot see prose, so
    // knowing *which* records are in the file is the only way to judge how much
    // prompt and file content a fixture is about to carry into the repository.
    console.log("\nRecords by method:");
    for (const [method, count] of Object.entries(census).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      console.log(`  ${method.padEnd(44)} ${count}`);
    }
    if (result.totalHits > 0) {
      console.error("\n--check: this recording still contains data that needs scrubbing.");
      process.exit(1);
    }
    console.log("\n--check: no redaction pattern matched.");
    console.log(
      "This is not a clean bill of health: no pattern covers prompts, command "
      + "output or diffs. Re-run with --strip-content, or read the census above "
      + "and the file itself.",
    );
    return;
  }

  writeFileSync(args.outputPath, result.output, "utf8");
  console.log(`\nWrote ${args.outputPath}`);
  console.log(
    "Read the diff before committing — the scrubber cannot recognise a secret it has no pattern for.",
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
