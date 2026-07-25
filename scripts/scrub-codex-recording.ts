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
 *   bun scripts/scrub-codex-recording.ts <input.jsonl> [output.jsonl]
 *   bun scripts/scrub-codex-recording.ts <input.jsonl> --check
 *
 * With `--check` nothing is written; it exits non-zero if anything would be
 * redacted, which is what CI can use to reject an unscrubbed fixture.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

const REDACTED = "«redacted»";

interface Redaction {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Ordered most-specific first: a key pattern must win before the generic
 * long-token pattern gets a chance to mangle it into something unrecognisable.
 */
function buildRedactions(): Redaction[] {
  const home = homedir();
  const user = basename(home);

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
    { name: "username", pattern: new RegExp(`\\b${escapeRegExp(user)}\\b`, "g"), replacement: "user" },
    { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "user@example.com" },
    // Private-range IPs, which identify an internal network.
    {
      name: "private-ip",
      pattern: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
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

async function main(): Promise<void> {
  const [inputPath, target] = process.argv.slice(2);
  if (!inputPath) {
    console.error("usage: bun scripts/scrub-codex-recording.ts <input.jsonl> [output.jsonl|--check]");
    process.exit(2);
  }

  const input = readFileSync(inputPath, "utf8");
  const result = scrub(input);
  const validation = validateJsonl(result.output);

  console.log(`Read ${validation.lines} JSONL records from ${inputPath}`);
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

  if (target === "--check") {
    if (result.totalHits > 0) {
      console.error("\n--check: this recording still contains data that needs scrubbing.");
      process.exit(1);
    }
    console.log("\n--check: clean.");
    return;
  }

  const outputPath = target ?? inputPath;
  writeFileSync(outputPath, result.output, "utf8");
  console.log(`\nWrote ${outputPath}`);
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
