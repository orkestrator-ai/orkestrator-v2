import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { LocalServerRuntime } from "./local-server-runtime.js";
import type { PtyProcess } from "./pty.js";
import { TerminalRuntime } from "./terminal-runtime.js";

/**
 * The processes preview ownership treats as "started by this backend for an
 * environment": local terminal shells and local agent bridges.
 */
describe("managed process roots", () => {
  test("local terminal shells are roots; container terminals are not", () => {
    const terminals = new TerminalRuntime();
    const pty = (pid: number) => ({ pid }) as unknown as PtyProcess;
    terminals.rememberSession("env-a:1", {
      kind: "local",
      environmentId: "env-a",
      cols: 80,
      rows: 24,
    });
    terminals.registerProcess("env-a:1", pty(4100));
    terminals.rememberSession("env-b:1", {
      kind: "container",
      containerId: "c",
      environmentId: "env-b",
      cols: 80,
      rows: 24,
    });
    terminals.registerProcess("env-b:1", pty(4200));
    // A session whose shell has not started yet has no process.
    terminals.rememberSession("env-a:2", {
      kind: "local",
      environmentId: "env-a",
      cols: 80,
      rows: 24,
    });
    expect(terminals.localProcessRoots()).toEqual([{ environmentId: "env-a", pid: 4100 }]);
  });

  test("live local agent bridges are roots for their environment", () => {
    const servers = new LocalServerRuntime();
    const child = (pid: number | undefined, exitCode: number | null = null) =>
      ({ pid, exitCode }) as unknown as ChildProcessWithoutNullStreams;
    servers.adoptProcess("claude:env-a", child(5100), { workingDirectory: "/w/a" });
    servers.adoptProcess("codex:env-b", child(5200), { workingDirectory: "/w/b" });
    servers.adoptProcess("codex:env-c", child(5300, 0), { workingDirectory: "/w/c" });
    servers.adoptProcess("probe-without-kind", child(5400));
    servers.adoptProcess("opencode:env-d", child(undefined));
    expect(servers.localProcessRoots()).toEqual([
      { environmentId: "env-a", pid: 5100 },
      { environmentId: "env-b", pid: 5200 },
    ]);
  });
});
