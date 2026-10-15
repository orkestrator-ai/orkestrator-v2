import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const core = resolve(repoRoot, "apps/backend/src/core");
const runtimeStatePath = resolve(core, "commands-runtime-state.ts");
const diffStatsTrackingPath = resolve(core, "diff-stats-tracking.ts");

/**
 * `commands-runtime-state` and `commands-files` used to import each other: the
 * scanners in `commands-files` read shared runtime constants from this module,
 * and the `DiffStatsService` constructed here needed the scanners, so it loaded
 * them with `await import()` (which `import/no-cycle` does not see).
 *
 * The service now lives in `DiffStatsTracking`, owned by `BackendRuntime`, and
 * imports the scanners statically; `commands-files` never imports it back. This
 * pins that the lazy imports stay gone and that either entry order loads. See
 * also `module-import-cycles.test.ts`.
 */
describe("commands-runtime-state load order", () => {
  test("the git-status scanners are imported statically, without a cycle dodge", () => {
    const runtimeState = readFileSync(runtimeStatePath, "utf8");
    const tracking = readFileSync(diffStatsTrackingPath, "utf8");

    expect(runtimeState).not.toContain('import("./commands-files.js")');
    expect(tracking).not.toContain('import("./commands-files.js")');
    expect(tracking).toMatch(/^\s*import\s[^;]*from\s+"\.\/commands-files\.js";/m);
  });

  test("importing the runtime state first, then building a tracker, resolves the scanners", async () => {
    // The entry order that used to hit the temporal dead zone.
    const runtimeState = await import(runtimeStatePath);
    expect(typeof runtimeState.MAX_TERMINAL_OUTPUT_BUFFER_CHARS).toBe("number");
    expect(runtimeState.WORKSPACE_ARTIFACT_GIT_EXCLUDE_PATTERNS.length).toBeGreaterThan(0);

    const { DiffStatsTracking } = await import(diffStatsTrackingPath);
    const tracking = new DiffStatsTracking({ emit: () => undefined });
    try {
      expect(tracking.service.trackedIds()).toEqual([]);
    } finally {
      tracking.shutdown();
    }

    const files = await import(resolve(core, "commands-files.ts"));
    expect(typeof files.getLocalGitStatusDetailed).toBe("function");
    expect(typeof files.getContainerGitStatusDetailed).toBe("function");
  });
});
