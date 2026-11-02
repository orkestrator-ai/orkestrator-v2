import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const oxlint = join(repoRoot, "node_modules/.bin/oxlint");

/**
 * Paths excluded for good. A test's console is not the application log, and for
 * the rest `console` is the product: a CLI's and a script's output, a container
 * script with no logger to import, a bridge's build script, a live probe whose
 * stdout is the test's result channel, the renderer's build script, the five files
 * that wrap or write the console themselves (the logger, the application log
 * writer, the fatal rejection guard, the backend's bounded console and the bug
 * report recorder), and the renderer's startup markers, whose exact text the
 * desktop matches.
 * `fatal-rejections.ts` is serialized into workers, so it cannot import anything.
 */
const PERMANENT: readonly string[] = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/test/**",
  "**/tests/**",
  "**/testing/**",
  "e2e/**",
  "**/mocks/**",
  "**/*test-harness*",
  "**/*test-support*",
  "**/*test-helpers*",
  "**/*test-fixtures*",
  "scripts/**",
  "apps/desktop/scripts/**",
  "bridges/*/scripts/**",
  "apps/backend/scripts/**",
  "**/*.live-probe.ts",
  "packages/cli/**",
  "docker/**",
  "packages/protocol/src/logger.ts",
  "packages/protocol/src/node/application-logging.ts",
  "packages/protocol/src/fatal-rejections.ts",
  "apps/backend/src/bounded-console.ts",
  "apps/web/scripts/**",
  "apps/web/src/lib/desktop-startup-marker.ts",
  "apps/web/src/lib/bug-report/renderer-errors.ts",
];

// Generated protocol, fixtures and build outputs only. Pin this separately from
// the permanent console exemptions: widening lint's ignores must be reviewed too.
const IGNORED = [
  "bridges/codex-bridge/src/app-server/generated/**",
  "test-fixtures/**",
  "output/**",
  "binaries/**",
];

const RAW_CONSOLE = /\bconsole\.(?:log|info|warn|error|debug|trace)\b/g;

interface LintConfig {
  ignorePatterns: string[];
  overrides: { files: string[]; rules: Record<string, unknown> }[];
}

function lintConfig(): LintConfig {
  return JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8")) as LintConfig;
}

function consoleExclusions(): string[][] {
  return lintConfig()
    .overrides.filter((override) => override.rules["no-restricted-globals"] === "off")
    .map((override) => override.files);
}

function trackedSources(root = repoRoot): string[] {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(result.status).toBe(0);
  return result.stdout.split("\n").filter((file) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(file));
}

/** Files lint checks for `console`: everything it does not ignore or exclude for good. */
function lintedSources(root = repoRoot): string[] {
  const skipped = [...IGNORED, ...PERMANENT].map((glob) => new Bun.Glob(glob));
  return trackedSources(root).filter((file) => !skipped.some((glob) => glob.match(file)));
}

function rawConsoleSites(file: string, root: string): number {
  let text: string;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    return 0; // Listed but deleted in this working tree.
  }
  // Lint covers all console references. Refuse suppressions of that rule so
  // aliases, computed access and less common methods cannot bypass it.
  const disables = Array.from(
    text.matchAll(
      /\/\/[ \t]*((?:oxlint|eslint)-disable[^\n]*)|\/\*\s*((?:oxlint|eslint)-disable[\s\S]*?)\*\//g,
    ),
  ).filter((comment) => {
    const directive = (comment[1] ?? comment[2] ?? "").match(
      /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\b([\s\S]*)/,
    );
    if (!directive) return false;
    const rules = directive[1]!.split("--")[0]!.trim();
    return !rules || /\bno-restricted-globals\b/.test(rules);
  });
  return (text.match(RAW_CONSOLE)?.length ?? 0) + disables.length;
}

function scanViolations(root = repoRoot) {
  return lintedSources(root)
    .map((file) => [file, rawConsoleSites(file, root)] as const)
    .filter(([, count]) => count > 0);
}

function lintCodes(path: string, source: string): string[] {
  // Mirrors the path outside the checkout, as domain-import-boundaries.test.ts
  // does, so a deliberate violation cannot reach a concurrent lint or scan.
  const root = mkdtempSync(join(tmpdir(), "orkestrator-raw-console-"));
  try {
    copyFileSync(join(repoRoot, ".oxlintrc.json"), join(root, ".oxlintrc.json"));
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    const result = spawnSync(oxlint, ["--format=json", "--threads=1", path], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    const report = JSON.parse(result.stdout) as { diagnostics: { code: string }[] };
    return report.diagnostics
      .map((diagnostic) => diagnostic.code)
      .filter((code) => code === "eslint(no-restricted-globals)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const RESTRICTED = "eslint(no-restricted-globals)";

describe("raw console", () => {
  test("the exclusions are exactly this list, so a new one cannot slip in", () => {
    expect(consoleExclusions()).toEqual([[...PERMANENT]]);
    expect(lintConfig().ignorePatterns).toEqual(IGNORED);
  });

  // The migration is finished, so no path is left to burn down. Lint already
  // refuses these sites; the scan also catches one hidden behind a disable
  // directive, which the docs do not allow for this rule.
  test("no linted source holds a raw console site", () => {
    expect(scanViolations()).toEqual([]);
  });

  test.each([
    'console.warn("x");',
    "// oxlint-disable-next-line no-restricted-globals\nconsole.table([]);",
    "/* oxlint-disable no-restricted-globals */\nconst out = console; out.dir({});",
    '/* eslint-disable */\nconsole?.["assert"](false);',
    'console["time"]("x"); // eslint-disable-line no-restricted-globals',
    'const url = "https://example.com"; /* oxlint-disable-line no-restricted-globals */ console.dir(url);',
    "/* oxlint-disable\n no-restricted-globals, no-unused-vars */\nconsole.group();",
    "/* oxlint-disable -- blanket suppression */\nconsole.timeEnd();",
  ])("the repository scan rejects a planted source: %s", (source) => {
    const root = mkdtempSync(join(tmpdir(), "orkestrator-console-scan-"));
    try {
      expect(spawnSync("git", ["init", "--quiet", root]).status).toBe(0);
      const file = "apps/backend/src/probe.ts";
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
      expect(scanViolations(root).map(([path]) => path)).toEqual([file]);
      // A suppression for a different rule does not trip the console guard.
      writeFileSync(join(root, file), "/* oxlint-disable no-unused-vars */\nconst value = 1;");
      expect(scanViolations(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the scan reaches every application tree", () => {
    const linted = lintedSources();
    for (const prefix of [
      "apps/backend/src/",
      "apps/desktop/electron/",
      "apps/web/src/",
      "apps/web-public/src/",
      "bridges/claude-bridge/src/",
      "bridges/codex-bridge/src/",
      "bridges/cursor-bridge/src/",
      "bridges/pi-bridge/src/",
      "bridges/acp-bridge/src/",
      "packages/protocol/src/",
      "packages/toolchain/src/",
    ]) {
      expect(linted.some((file) => file.startsWith(prefix))).toBe(true);
    }
    expect(linted).not.toContain("apps/backend/src/bounded-console.ts");
    expect(linted.some((file) => file.endsWith(".test.ts"))).toBe(false);
  });
});

describe("raw console lint rule", () => {
  test.each([
    ["apps/desktop/electron/probe.ts"],
    ["packages/protocol/src/probe.ts"],
    ["packages/toolchain/src/probe.ts"],
    ["bridges/claude-bridge/src/probe.ts"],
    ["apps/backend/src/core/probe.ts"],
    ["apps/web/src/lib/probe.ts"],
    ["apps/web-public/src/probe.ts"],
    ["packages/protocol/src/bridge-lifecycle.ts"],
  ])("rejects console in %s, used directly or passed as a value", (path) => {
    expect(lintCodes(path, 'console.warn("x");\nexport const logger = console;\n')).toEqual([
      RESTRICTED,
      RESTRICTED,
    ]);
  });

  test("allows a local variable that happens to be called console", () => {
    expect(
      lintCodes(
        "apps/desktop/electron/probe.ts",
        "export function f(console: { warn(): void }) {\n  console.warn();\n}\n",
      ),
    ).toEqual([]);
  });

  test.each([
    ["packages/protocol/src/logger.ts"],
    ["packages/protocol/src/node/application-logging.ts"],
    ["apps/backend/src/bounded-console.ts"],
    ["apps/backend/scripts/probe.ts"],
    ["apps/web/scripts/probe.ts"],
    ["apps/web/src/lib/desktop-startup-marker.ts"],
    ["apps/web/src/lib/bug-report/renderer-errors.ts"],
    ["bridges/claude-bridge/scripts/probe.ts"],
    ["bridges/claude-bridge/src/services/probe.live-probe.ts"],
    ["apps/desktop/tests/probe.test.ts"],
    ["apps/desktop/scripts/probe.ts"],
    ["packages/cli/src/probe.ts"],
  ])("allows console in %s", (path) => {
    expect(lintCodes(path, 'console.warn("x");\nexport {};\n')).toEqual([]);
  });
});
