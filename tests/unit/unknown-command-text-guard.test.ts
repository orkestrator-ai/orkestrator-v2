/**
 * Plan item 1005: the renderer detects "this machine does not have that
 * command" from a code, through `incompatibility()` in
 * `@orkestrator/protocol/contract/errors`, never by matching the backend's
 * `Unknown backend command: <name>` text itself. Only the protocol helper
 * reads the legacy text, for pre-contract nodes.
 *
 * Tests and test fakes may still *build* that text (an older backend's
 * answer); this guard scans renderer source, with comments removed.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const webSource = join(repoRoot, "apps/web/src");

/** Matching the legacy wording: a literal, a regex, or the protocol's text-only helpers. */
const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "the legacy text", pattern: /Unknown backend command/u },
  { name: "the never-sent wording", pattern: /Unknown command:/iu },
  { name: "a regex for the legacy text", pattern: /unknown \(\??:?\s*backend \)\??\s*command/iu },
  { name: "a regex for the legacy text", pattern: /\/[^/\n]*unknown (backend )?command/iu },
  { name: "the text-only helper", pattern: /\bisUnknownCommandError\b/u },
];

function isTestSupport(path: string): boolean {
  return (
    /\.test\.tsx?$/u.test(path) ||
    /(^|\/)test\//u.test(path) ||
    /[-.]test-(backend|support|fixtures?)\.tsx?$/u.test(path) ||
    /-fakes?\.tsx?$/u.test(path)
  );
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

/** Drops block and line comments, keeping line numbers (a string holding `//` is kept). */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gu, "$1");
}

export function findings(text: string): string[] {
  const found: string[] = [];
  withoutComments(text)
    .split("\n")
    .forEach((line, index) => {
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(line)) found.push(`${index + 1}: ${name}`);
      }
    });
  return found;
}

describe("unknown-command text matching in the renderer", () => {
  test("the guard recognises the matchers it replaces", () => {
    for (const matcher of [
      'if (message.includes("Unknown backend command")) return;',
      'if (message.startsWith("Unknown backend command:")) return "unsupported";',
      "return /unknown command|not available in this backend/i.test(message);",
      "if (/unknown (?:backend )?command/i.test(message)) {",
      "const UNSUPPORTED = /unknown (backend )?command|unsupported command/i;",
      "message.includes(`Unknown command: ${command}`)",
      'import { isUnknownCommandError } from "@orkestrator/protocol/unknown-command";',
    ]) {
      expect(findings(matcher)).not.toEqual([]);
    }
    for (const allowed of [
      '// Older backends answer "Unknown backend command".',
      '/**\n * The backend answers "Unknown backend command" once.\n */',
      'if (incompatibility(error, "get_x")?.code === "unknown-command") return null;',
      "const url = 'https://example.test/unknown';",
    ]) {
      expect(findings(allowed)).toEqual([]);
    }
  });

  test("no renderer source matches the legacy text itself", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(webSource)) {
      const name = relative(repoRoot, path);
      if (isTestSupport(name)) continue;
      for (const finding of findings(readFileSync(path, "utf8"))) {
        offenders.push(`${name}:${finding}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
