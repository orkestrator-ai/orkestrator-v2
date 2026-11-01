import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const oxlint = join(repoRoot, "node_modules/.bin/oxlint");

/**
 * Paths still excluded from the raw `console` lint rule while they wait to move
 * onto the shared logger (docs/architecture/logging.md), with the most sites
 * each may hold. Both only go down: a slice that migrates a path removes its
 * entry here and in `.oxlintrc.json`, and a change that needs a new log line
 * uses the logger, which needs no number raised.
 */
const UNMIGRATED: Readonly<Record<string, number>> = {
  "apps/backend/**": 455,
  "apps/web/**": 369,
  "apps/web-public/**": 0,
  "bridges/acp-bridge/**": 9,
  "bridges/claude-bridge/**": 71,
  "bridges/codex-bridge/**": 77,
  "bridges/cursor-bridge/**": 11,
  "bridges/pi-bridge/**": 4,
  "packages/protocol/src/bridge-lifecycle.ts": 1,
  "packages/protocol/src/event-loop-stall-monitor.ts": 1,
  "packages/protocol/src/node/bridge-diagnostics.ts": 2,
};

/**
 * Paths excluded for good. A test's console is not the application log, and for
 * the rest `console` is the product: a CLI's and a script's output, a container
 * script with no logger to import, and the three files that wrap the console.
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
  "packages/cli/**",
  "docker/**",
  "packages/protocol/src/logger.ts",
  "packages/protocol/src/node/application-logging.ts",
  "packages/protocol/src/fatal-rejections.ts",
  "apps/backend/src/bounded-console.ts",
];

const RAW_CONSOLE = /\bconsole\.(?:log|info|warn|error|debug|trace)\b/g;
const TEST_FILE =
  /\.test\.tsx?$|\/test\/|\/tests\/|\/testing\/|\/mocks\/|test-harness|test-support|test-helpers|test-fixtures|\/generated\//;

interface LintOverride {
  files: string[];
  rules: Record<string, unknown>;
}

function consoleExclusions(): string[][] {
  const config = JSON.parse(readFileSync(join(repoRoot, ".oxlintrc.json"), "utf8")) as {
    overrides: LintOverride[];
  };
  return config.overrides
    .filter((override) => override.rules["no-restricted-globals"] === "off")
    .map((override) => override.files);
}

function trackedSources(): string[] {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(result.status).toBe(0);
  return result.stdout
    .split("\n")
    .filter((file) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(file) && !TEST_FILE.test(file));
}

function rawConsoleSites(pattern: string, sources: string[]): number {
  const matches = pattern.endsWith("/**")
    ? sources.filter((file) => file.startsWith(pattern.slice(0, -2)))
    : sources.filter((file) => file === pattern);
  let sites = 0;
  for (const file of matches) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, file), "utf8");
    } catch {
      continue; // Listed but deleted in this working tree.
    }
    sites += text.match(RAW_CONSOLE)?.length ?? 0;
  }
  return sites;
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

describe("raw console ratchet", () => {
  test("the exclusions are exactly these lists, so a new one cannot slip in", () => {
    expect(consoleExclusions()).toEqual([[...PERMANENT], Object.keys(UNMIGRATED)]);
  });

  test("no unmigrated path gains a raw console site", () => {
    const sources = trackedSources();
    const over = Object.entries(UNMIGRATED).flatMap(([pattern, limit]) => {
      const sites = rawConsoleSites(pattern, sources);
      return sites > limit ? [`${pattern}: ${sites} sites, limit ${limit}`] : [];
    });
    expect(over).toEqual([]);
  });

  test("a limit that has fallen is lowered, so the ground gained cannot be lost", () => {
    const sources = trackedSources();
    const slack = Object.entries(UNMIGRATED).flatMap(([pattern, limit]) => {
      const sites = rawConsoleSites(pattern, sources);
      // A little room for unrelated edits, so removing one line needs no change
      // here. A migration removes far more than this.
      return limit - sites > Math.max(10, limit / 10) ? [`${pattern}: ${sites} of ${limit}`] : [];
    });
    expect(slack).toEqual([]);
  });

  test("the electron main process holds no raw console site", () => {
    expect(rawConsoleSites("apps/desktop/electron/**", trackedSources())).toBe(0);
  });
});

describe("raw console lint rule", () => {
  test.each([
    ["apps/desktop/electron/probe.ts"],
    ["packages/protocol/src/probe.ts"],
    ["packages/toolchain/src/probe.ts"],
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
    ["apps/backend/src/core/probe.ts"],
    ["apps/web/src/lib/probe.ts"],
    ["bridges/claude-bridge/src/probe.ts"],
    ["apps/desktop/tests/probe.test.ts"],
    ["apps/desktop/scripts/probe.ts"],
    ["packages/cli/src/probe.ts"],
  ])("allows console in %s", (path) => {
    expect(lintCodes(path, 'console.warn("x");\nexport {};\n')).toEqual([]);
  });
});
