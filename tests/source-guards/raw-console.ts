import type { SourceIndex } from "./repository-index";

/**
 * Raw `console` (docs/development/linting.md, "Raw `console`"). Lint's
 * `no-restricted-globals` refuses every console reference outside the paths
 * below, so this module adds only what lint cannot see: a directive that
 * disables that rule. The repository scan runs in the guard stage
 * (`mise run guards`); `tests/unit/raw-console.test.ts` pins these lists
 * against `.oxlintrc.json` and plants offenders.
 */

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
export const PERMANENT: readonly string[] = [
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
export const IGNORED = [
  "bridges/codex-bridge/src/app-server/generated/**",
  "test-fixtures/**",
  "output/**",
  "binaries/**",
];

const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|cjs)$/;

/** Files lint checks for `console`: every listed source it does not ignore or exclude for good. */
export function lintedSources(index: SourceIndex): string[] {
  const skipped = [...IGNORED, ...PERMANENT].map((glob) => new Bun.Glob(glob));
  return index.files.filter(
    (file) => SOURCE_FILE.test(file) && !skipped.some((glob) => glob.match(file)),
  );
}

/**
 * Directives that disable `no-restricted-globals`, by name or as a blanket
 * disable. Lint refuses every console reference itself; a suppression is the
 * only way past it, and the docs do not allow one for this rule.
 */
export function consoleRuleDisables(text: string): number {
  return Array.from(
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
  }).length;
}

/** Linted sources holding a directive that disables the console rule, with their count. */
export function consoleRuleDisableViolations(index: SourceIndex): Array<[string, number]> {
  const violations: Array<[string, number]> = [];
  for (const file of lintedSources(index)) {
    const text = index.read(file);
    // Listed but deleted in this working tree.
    if (text === null || !text.includes("-disable")) continue;
    const count = consoleRuleDisables(text);
    if (count > 0) violations.push([file, count]);
  }
  return violations;
}

/** Application trees lint must reach, so an ignore pattern cannot quietly drop one. */
export const APPLICATION_TREES: readonly string[] = [
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
];

/** Every way the checkout breaks the console rule's coverage, as one line each. */
export function checkRawConsole(index: SourceIndex): string[] {
  const problems = consoleRuleDisableViolations(index).map(
    ([file, count]) =>
      `${file}: ${count} directive(s) disabling no-restricted-globals; use createLogger from @orkestrator/protocol/logger instead`,
  );
  const linted = lintedSources(index);
  for (const prefix of APPLICATION_TREES)
    if (!linted.some((file) => file.startsWith(prefix)))
      problems.push(`the console rule no longer reaches ${prefix}`);
  if (linted.includes("apps/backend/src/bounded-console.ts"))
    problems.push(
      "apps/backend/src/bounded-console.ts is no longer excluded from the console rule",
    );
  if (linted.some((file) => file.endsWith(".test.ts")))
    problems.push("test files are no longer excluded from the console rule");
  return problems;
}
