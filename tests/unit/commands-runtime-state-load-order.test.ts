import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const runtimeStatePath = resolve(repoRoot, "apps/backend/src/core/commands-runtime-state.ts");

/**
 * `commands-runtime-state` and `commands-files` import each other: the scanners
 * in `commands-files` read shared runtime constants from this module, and the
 * `DiffStatsService` constructed here needs the scanners. A static import of the
 * scanners therefore evaluates `commands-files` while this module's own
 * constants are still in the temporal dead zone, and whichever module the
 * process imports first decides whether that throws. Loading them inside the
 * scan callback defers the edge past module evaluation.
 *
 * The invariant is easy to "tidy" back into a static import, and the resulting
 * failure only reproduces under one entry order, so it is pinned here. See also
 * `module-import-cycles.test.ts`, which records the cycle set itself.
 */
describe("commands-runtime-state load order", () => {
  test("the git-status scanners are loaded lazily, not statically", () => {
    const source = readFileSync(runtimeStatePath, "utf8");

    expect(source).toContain('await import("./commands-files.js")');
    // A static import at any position would be hoisted and re-create the cycle.
    expect(source).not.toMatch(/^\s*import\s[^;]*from\s+"\.\/commands-files\.js";/m);
  });

  test("importing the module first, then driving a scan, resolves the scanners", async () => {
    // Deliberately import `commands-runtime-state` before `commands-files`:
    // this is the entry order that a static import would break.
    const runtimeState = await import(runtimeStatePath);

    expect(runtimeState.diffStatsService).toBeDefined();
    // The shared constants must be assigned, not undefined-by-TDZ, at the point
    // the service exists.
    expect(typeof runtimeState.MAX_TERMINAL_OUTPUT_BUFFER_CHARS).toBe("number");
    expect(runtimeState.WORKSPACE_ARTIFACT_GIT_EXCLUDE_PATTERNS.length).toBeGreaterThan(0);

    const files = await import(resolve(repoRoot, "apps/backend/src/core/commands-files.ts"));
    expect(typeof files.getLocalGitStatusDetailed).toBe("function");
    expect(typeof files.getContainerGitStatusDetailed).toBe("function");
  });
});
