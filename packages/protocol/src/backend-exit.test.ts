import { describe, expect, test } from "bun:test";
import {
  BACKEND_EXIT_CAUSES,
  classifyBackendExit,
  isBackendExitCause,
  isBunCrashReportLine,
} from "./backend-exit";

describe("classifyBackendExit", () => {
  test("an exit code is an exit, not a crash", () => {
    expect(classifyBackendExit({ exitCode: 1, signal: null })).toBe("exit-code");
    expect(classifyBackendExit({ exitCode: 0, signal: null })).toBe("exit-code");
  });

  test("a fault signal is a crash; another signal is a termination", () => {
    for (const signal of ["SIGSEGV", "SIGBUS", "SIGABRT", "SIGILL", "SIGFPE", "SIGTRAP", "SIGSYS"])
      expect(classifyBackendExit({ exitCode: null, signal })).toBe("crashed");
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT", "SIGPIPE"])
      expect(classifyBackendExit({ exitCode: null, signal })).toBe("terminated");
  });

  test("SIGKILL is an OOM kill only when the cgroup counted one", () => {
    expect(classifyBackendExit({ exitCode: null, signal: "SIGKILL", oomKills: 1 })).toBe(
      "oom-killed",
    );
    expect(classifyBackendExit({ exitCode: null, signal: "SIGKILL", oomKills: 0 })).toBe("killed");
    expect(classifyBackendExit({ exitCode: null, signal: "SIGKILL", oomKills: null })).toBe(
      "killed",
    );
  });

  test("Bun's crash report makes any exit a crash, and a failed child a spawn error", () => {
    expect(classifyBackendExit({ exitCode: 133, signal: null, crashReport: true })).toBe("crashed");
    expect(classifyBackendExit({ exitCode: null, signal: "SIGTERM", crashReport: true })).toBe(
      "crashed",
    );
    expect(classifyBackendExit({ exitCode: null, signal: null, spawnError: true })).toBe(
      "spawn-error",
    );
  });

  test("every result is a listed cause", () => {
    expect(isBackendExitCause("killed")).toBe(true);
    expect(isBackendExitCause("Error")).toBe(false);
    expect(new Set(BACKEND_EXIT_CAUSES).size).toBe(BACKEND_EXIT_CAUSES.length);
  });
});

describe("isBunCrashReportLine", () => {
  test("matches Bun's panic line and banner, not ordinary log lines", () => {
    expect(isBunCrashReportLine("panic(main thread): Segmentation fault at address 0x0")).toBe(
      true,
    );
    expect(isBunCrashReportLine("panic: integer overflow")).toBe(true);
    expect(
      isBunCrashReportLine("oh no: Bun has crashed. This indicates a bug in Bun, not your code."),
    ).toBe(true);
    expect(isBunCrashReportLine("[backend] shutdown.finished code=0")).toBe(false);
    expect(isBunCrashReportLine("the agent said: don't panic")).toBe(false);
  });
});
