/**
 * The execution-policy conformance suite cannot quietly lose a platform.
 *
 * The suite (`tests/conformance/execution-policy`) runs inside each adapter's
 * own test group. This file checks the wiring from outside: every platform has
 * a runner that its package's test script selects, every runner names the
 * platform it claims, and every declared narrowing names a real shape and
 * says why.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { EXECUTION_POLICY_NARROWINGS } from "../conformance/execution-policy/narrowings";
import { POLICY_PLATFORMS, POLICY_SHAPES } from "../conformance/execution-policy/shapes";
import { slowTestFiles } from "../../scripts/test-tiers";

const root = path.resolve(import.meta.dir, "../..");

/** Where each platform's adapter lives; OpenCode runs inside the backend. */
const RUNNERS: Record<(typeof POLICY_PLATFORMS)[number], { pkg: string; script: string }> = {
  claude: { pkg: "bridges/claude-bridge", script: "test:bridge" },
  codex: { pkg: "bridges/codex-bridge", script: "test:bridge" },
  cursor: { pkg: "bridges/cursor-bridge", script: "test:bridge" },
  pi: { pkg: "bridges/pi-bridge", script: "test:bridge" },
  grok: { pkg: "bridges/acp-bridge", script: "test:bridge" },
  opencode: { pkg: "apps/backend", script: "test:workspace" },
};

function runnerPath(platform: (typeof POLICY_PLATFORMS)[number]): string {
  const { pkg } = RUNNERS[platform];
  return path.join(
    root,
    pkg,
    pkg === "apps/backend" ? "src/core" : "src",
    "conformance-execution-policy.test.ts",
  );
}

describe("execution policy conformance runners", () => {
  test.each([...POLICY_PLATFORMS])(
    "%s runs the shared suite from its own test group",
    (platform) => {
      const runner = runnerPath(platform);
      expect(existsSync(runner)).toBe(true);
      const source = readFileSync(runner, "utf8");
      expect(source).toContain("runExecutionPolicyConformance(");
      expect(source).toContain(`platform: "${platform}"`);
      // A runner outside the directory its package test script selects would
      // never execute under `mise run test`.
      const { scripts } = JSON.parse(
        readFileSync(path.join(root, RUNNERS[platform].pkg, "package.json"), "utf8"),
      ) as { scripts: Record<string, string> };
      expect(scripts[RUNNERS[platform].script]).toMatch(
        /^bun \.\.\/\.\.\/scripts\/bun-test-tier\.ts \S+ (?:\S+ )*src\b.* -- /,
      );
      // The default tier must keep it: the slow tier runs only on demand.
      expect(slowTestFiles(root, RUNNERS[platform].pkg)).not.toContain(
        path.relative(path.join(root, RUNNERS[platform].pkg), runner),
      );
    },
  );

  test("a suite change marks every runner's test task affected", () => {
    const turbo = JSON.parse(readFileSync(path.join(root, "turbo.json"), "utf8")) as {
      tasks: Record<string, { inputs?: string[] }>;
    };
    for (const task of ["test:bridge", "test:workspace"]) {
      expect(turbo.tasks[task]?.inputs).toContain("$TURBO_ROOT$/tests/conformance/**");
    }
  });
});

describe("execution policy narrowings", () => {
  const shapeIds = new Set<string>(POLICY_SHAPES.map((shape) => shape.id));

  test("cover exactly the platforms the suite runs", () => {
    expect(Object.keys(EXECUTION_POLICY_NARROWINGS).sort()).toEqual([...POLICY_PLATFORMS].sort());
  });

  test("name real shapes and say why", () => {
    for (const row of Object.values(EXECUTION_POLICY_NARROWINGS)) {
      for (const [shape, narrowing] of Object.entries(row)) {
        expect(shapeIds.has(shape)).toBe(true);
        expect(narrowing!.reason.trim().length).toBeGreaterThan(20);
      }
    }
  });

  test("shape ids are unique", () => {
    expect(shapeIds.size).toBe(POLICY_SHAPES.length);
  });
});
