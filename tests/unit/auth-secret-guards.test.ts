/**
 * The auth-secret canary tests cannot quietly lose coverage.
 *
 * Every bridge that serves `/global/auth`, and every backend module that turns
 * an auth answer into `NativeAgentAuthStatus`, must keep a test that plants
 * the canaries from `tests/helpers/auth-secret-canaries.ts` and checks the
 * answer and the output. A new bridge, or a parser moved to a new file, fails
 * here until it has one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const HELPER = "tests/helpers/auth-secret-canaries";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (entry === "node_modules" || entry === "generated") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

function canaryTests(files: string[]): string[] {
  return files.filter(
    (file) => /\.test\.tsx?$/.test(file) && readFileSync(file, "utf8").includes(HELPER),
  );
}

describe("auth-secret canary coverage", () => {
  const bridges = readdirSync(path.join(root, "bridges")).filter((name) =>
    name.endsWith("-bridge"),
  );

  test("finds the bridges", () => {
    expect(bridges.length).toBeGreaterThanOrEqual(5);
  });

  test.each(bridges)("%s checks its auth routes with the canaries", (bridge) => {
    const files = sourceFiles(path.join(root, "bridges", bridge, "src"));
    const servesAuth = files.some(
      (file) =>
        !/\.test\.tsx?$/.test(file) && readFileSync(file, "utf8").includes('"/global/auth"'),
    );
    if (!servesAuth) return;
    expect(canaryTests(files), `${bridge} has no auth-secret canary test`).not.toHaveLength(0);
  });

  test.each([
    // The bridge-answer parser for every HTTP bridge.
    ["apps/backend/src/core/http-bridge-catalog.ts", "authStatus()"],
    // OpenCode answers from its SDK, not a bridge.
    ["apps/backend/src/core/opencode-capabilities.ts", "authStatus()"],
  ])("%s keeps a canary test beside it", (relative, marker) => {
    const source = path.join(root, relative);
    expect(readFileSync(source, "utf8")).toContain(marker);
    const directory = path.dirname(source);
    const tests = canaryTests(
      readdirSync(directory).map((entry) => path.join(directory, entry)),
    ).filter((file) => {
      const text = readFileSync(file, "utf8");
      return relative.includes("opencode")
        ? text.includes("OpenCodeCapabilities")
        : text.includes("beginSignIn");
    });
    expect(tests, `${relative} has no auth-secret canary test`).not.toHaveLength(0);
  });
});
