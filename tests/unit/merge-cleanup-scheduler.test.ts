import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  BackendRuntime,
  type BackendRuntimeOptions,
} from "@/../../backend/src/core/backend-runtime";
import type { CommandContext } from "@/../../backend/src/core/commands-context";

/**
 * `PrMonitorRuntime` observes a merged PR; `commands-servers` owns the cleanup
 * that follows. The backend passes that scheduler to `BackendRuntime` as
 * `prMonitor.scheduleMergeCleanup` (`index.ts`, `tests/command-fixtures.ts`)
 * rather than the monitor importing it, so the two modules stay acyclic (see
 * `module-import-cycles.test.ts`) and each backend calls its own.
 */
const MERGED = { url: "https://github.com/acme/repo/pull/7", state: "merged" } as const;

const runtimes: BackendRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.shutdown();
});

function runtimeWith(options: Omit<BackendRuntimeOptions, "emit"> = {}): BackendRuntime {
  const runtime = new BackendRuntime({ emit: () => undefined, ...options });
  runtimes.push(runtime);
  return runtime;
}

/** No environments, so a sync only binds the context to the monitor. */
function contextFor(runtime: BackendRuntime): CommandContext {
  return {
    storage: { loadEnvironments: async () => [], getEnvironment: async () => null },
    emit: () => undefined,
    runtime,
  } as unknown as CommandContext;
}

describe("merge cleanup scheduler option", () => {
  test("forwards a merged observation's cleanup with the bound context", async () => {
    const calls: Array<[string, CommandContext]> = [];
    const runtime = runtimeWith({
      prMonitor: { scheduleMergeCleanup: (environmentId, ctx) => calls.push([environmentId, ctx]) },
    });
    const context = contextFor(runtime);
    await runtime.prMonitor.sync(context);

    runtime.prMonitor.resumeTerminalEffects("env-merged", MERGED);
    // A closed PR has no cleanup to resume.
    runtime.prMonitor.resumeTerminalEffects("env-closed", { ...MERGED, state: "closed" });

    expect(calls).toEqual([["env-merged", context]]);
  });

  test("a runtime without a scheduler skips the cleanup without throwing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const runtime = runtimeWith();
      await runtime.prMonitor.sync(contextFor(runtime));

      expect(() => runtime.prMonitor.resumeTerminalEffects("env-1", MERGED)).not.toThrow();
      expect(() => runtime.prMonitor.resumeTerminalEffects("env-2", MERGED)).not.toThrow();
      // One warning per runtime, not one per observation.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("two runtimes each call their own scheduler", async () => {
    const first: Array<[string, CommandContext]> = [];
    const second: Array<[string, CommandContext]> = [];
    const firstRuntime = runtimeWith({
      prMonitor: { scheduleMergeCleanup: (environmentId, ctx) => first.push([environmentId, ctx]) },
    });
    const secondRuntime = runtimeWith({
      prMonitor: {
        scheduleMergeCleanup: (environmentId, ctx) => second.push([environmentId, ctx]),
      },
    });
    const firstContext = contextFor(firstRuntime);
    const secondContext = contextFor(secondRuntime);
    await firstRuntime.prMonitor.sync(firstContext);
    await secondRuntime.prMonitor.sync(secondContext);

    firstRuntime.prMonitor.resumeTerminalEffects("env-a", MERGED);
    secondRuntime.prMonitor.resumeTerminalEffects("env-b", MERGED);

    expect(first).toEqual([["env-a", firstContext]]);
    expect(second).toEqual([["env-b", secondContext]]);
  });
});
