import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  IGNORED,
  PERMANENT,
  consoleRuleDisableViolations,
  lintedSources,
} from "../source-guards/raw-console";
import { RepositoryIndex } from "../source-guards/repository-index";

const repoRoot = join(import.meta.dir, "../..");
const oxlint = join(repoRoot, "node_modules/.bin/oxlint");

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

function scanViolations(root: string) {
  return consoleRuleDisableViolations(RepositoryIndex.fromWalk(root));
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

  // The repository scan (directives that disable the rule, and that the
  // rule still reaches every application tree) runs once, in the guard stage
  // (`mise run guards`). Raw console calls themselves are lint's: the
  // `raw console lint rule` cases below pin that lint refuses them.
  test.each([
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
      const file = "apps/backend/src/probe.ts";
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
      expect(scanViolations(root).map(([path]) => path)).toEqual([file]);
      expect(lintedSources(RepositoryIndex.fromWalk(root))).toEqual([file]);
      // A suppression for a different rule does not trip the console guard,
      // and an excluded path may disable it.
      writeFileSync(join(root, file), "/* oxlint-disable no-unused-vars */\nconst value = 1;");
      expect(scanViolations(root)).toEqual([]);
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts/probe.ts"), source);
      expect(scanViolations(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
