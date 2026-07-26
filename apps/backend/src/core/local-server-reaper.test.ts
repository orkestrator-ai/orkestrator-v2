import { describe, expect, test } from "bun:test";
import {
  detachedProcessHandle,
  isPidAlive,
  parseProcessIdentity,
  reapOrphanedLocalServers,
  type ProcessIdentity,
} from "./local-server-reaper.js";
import type { Environment } from "./models.js";

/** A command line that satisfies every marker for the given kind. */
const COMMAND_LINES = {
  codex: "/app/bin/bun /app/bridges/codex-bridge/dist/index.js",
  claude: "/app/bin/bun /app/bridges/claude-bridge/dist/index.js",
  opencode: "/toolchains/opencode serve --port 5000 --hostname 127.0.0.1",
} as const;

/** An orphaned process that leads its own group — what a real bridge looks like. */
function orphanedLeader(pid: number, commandLine: string): ProcessIdentity {
  return { parentPid: 1, processGroupId: pid, commandLine };
}

function environment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "env",
    status: "stopped",
    order: 0,
    ...overrides,
  } as Environment;
}

interface Harness {
  identities?: Map<number, ProcessIdentity>;
  terminated?: number[];
  terminateResult?: boolean;
}

function makeOptions(environments: Environment[], harness: Harness = {}) {
  const updates: Array<{ environmentId: string; fields: Record<string, unknown> }> = [];
  const terminated: number[] = harness.terminated ?? [];
  return {
    updates,
    terminated,
    options: {
      storage: {
        loadEnvironments: async () => environments,
        updateEnvironment: async (environmentId: string, fields: Partial<Environment>) => {
          updates.push({ environmentId, fields: fields as Record<string, unknown> });
        },
      },
      readIdentity: async (pid: number) => harness.identities?.get(pid) ?? null,
      terminate: (async (child: { pid?: number }) => {
        if (child.pid) terminated.push(child.pid);
        return harness.terminateResult ?? true;
      }) as never,
      log: () => undefined,
    },
  };
}

describe("reapOrphanedLocalServers", () => {
  test("kills an orphaned bridge whose command line matches and clears its record", async () => {
    const { options, updates, terminated } = makeOptions(
      [environment({ codexBridgePid: 4242, localCodexPort: 5111 })],
      {
        identities: new Map([[4242, orphanedLeader(4242, COMMAND_LINES.codex)]]),
      },
    );

    const reaped = await reapOrphanedLocalServers(options);
    expect(terminated).toEqual([4242]);
    expect(reaped).toEqual([
      { environmentId: "env-1", kind: "codex", pid: 4242, outcome: "reaped" },
    ]);
    expect(updates).toEqual([
      { environmentId: "env-1", fields: { codexBridgePid: null, localCodexPort: null } },
    ]);
  });

  test("clears without signalling when the PID is dead or recycled by a stranger", async () => {
    const { options, updates, terminated } = makeOptions(
      [
        environment({ id: "env-dead", claudeBridgePid: 100 }),
        environment({ id: "env-recycled", claudeBridgePid: 200 }),
      ],
      {
        identities: new Map([
          // 100 is absent: the process is gone.
          [200, orphanedLeader(200, "/usr/bin/vim notes.txt")],
        ]),
      },
    );

    const reaped = await reapOrphanedLocalServers(options);
    expect(terminated).toEqual([]);
    expect(reaped.map((entry) => entry.outcome)).toEqual(["cleared", "cleared"]);
    expect(updates.map((update) => update.environmentId).sort()).toEqual([
      "env-dead",
      "env-recycled",
    ]);
  });

  test("leaves a bridge owned by another live backend alone", async () => {
    const { options, updates, terminated } = makeOptions(
      [environment({ codexBridgePid: 4242 })],
      {
        identities: new Map([
          [4242, {
            // Parented to this test process, which is definitely alive.
            parentPid: process.pid,
            processGroupId: 4242,
            commandLine: COMMAND_LINES.codex,
          }],
        ]),
      },
    );

    const reaped = await reapOrphanedLocalServers(options);
    expect(terminated).toEqual([]);
    expect(updates).toEqual([]);
    expect(reaped).toEqual([
      { environmentId: "env-1", kind: "codex", pid: 4242, outcome: "skipped-live-owner" },
    ]);
  });

  test("keeps the record when the kill fails so a later startup can retry", async () => {
    const { options, updates } = makeOptions(
      [environment({ opencodePid: 900 })],
      {
        identities: new Map([[900, orphanedLeader(900, COMMAND_LINES.opencode)]]),
        terminateResult: false,
      },
    );

    const reaped = await reapOrphanedLocalServers(options);
    expect(updates).toEqual([]);
    expect(reaped).toEqual([
      { environmentId: "env-1", kind: "opencode", pid: 900, outcome: "kill-failed" },
    ]);
  });

  test("clears obviously invalid PIDs without probing", async () => {
    const { options, updates, terminated } = makeOptions([
      environment({ codexBridgePid: 1, claudeBridgePid: process.pid }),
    ]);

    const reaped = await reapOrphanedLocalServers(options);
    expect(terminated).toEqual([]);
    expect(reaped.map((entry) => entry.outcome)).toEqual(["cleared", "cleared"]);
    expect(updates).toHaveLength(2);
  });

  test("refuses to signal a PID that does not lead its own process group", async () => {
    const { options, updates, terminated } = makeOptions(
      [environment({ codexBridgePid: 4242 })],
      {
        identities: new Map([
          // Orphaned and marker-matching, but a group member rather than its
          // leader. `terminateProcessTree` signals `-pid`, which would reach an
          // unrelated group entirely.
          [4242, { parentPid: 1, processGroupId: 900, commandLine: COMMAND_LINES.codex }],
        ]),
      },
    );

    const reaped = await reapOrphanedLocalServers(options);
    expect(terminated).toEqual([]);
    // The record is kept: clearing it would hide the anomaly from the next run.
    expect(updates).toEqual([]);
    expect(reaped).toEqual([
      {
        environmentId: "env-1",
        kind: "codex",
        pid: 4242,
        outcome: "skipped-not-group-leader",
      },
    ]);
  });

  test("does not treat a hand-started opencode process as a reapable server", async () => {
    const { options, terminated } = makeOptions(
      [environment({ opencodePid: 900 })],
      {
        identities: new Map([
          // A user's own `opencode` session whose terminal has exited, landing
          // on a recycled PID. The bare word alone used to be enough to kill it.
          [900, orphanedLeader(900, "/usr/local/bin/opencode")],
        ]),
      },
    );

    const reaped = await reapOrphanedLocalServers(options);
    expect(terminated).toEqual([]);
    expect(reaped.map((entry) => entry.outcome)).toEqual(["cleared"]);
  });

  test("requires every marker, not just the first", async () => {
    const { options, terminated } = makeOptions(
      [environment({ claudeBridgePid: 700 })],
      {
        identities: new Map([
          // Mentions claude-bridge (a log tail, an editor) but is not the bridge.
          [700, orphanedLeader(700, "/usr/bin/tail -f /tmp/claude-bridge.log")],
        ]),
      },
    );

    const reaped = await reapOrphanedLocalServers(options);
    expect(terminated).toEqual([]);
    expect(reaped.map((entry) => entry.outcome)).toEqual(["cleared"]);
  });

  test("reaps each recorded kind independently within one environment", async () => {
    const { options, updates, terminated } = makeOptions(
      [environment({ opencodePid: 901, claudeBridgePid: 902, codexBridgePid: 903 })],
      {
        identities: new Map([
          [901, orphanedLeader(901, COMMAND_LINES.opencode)],
          [902, orphanedLeader(902, COMMAND_LINES.claude)],
          [903, orphanedLeader(903, COMMAND_LINES.codex)],
        ]),
      },
    );

    const reaped = await reapOrphanedLocalServers(options);
    expect(terminated.sort()).toEqual([901, 902, 903]);
    expect(reaped.map((entry) => entry.kind).sort()).toEqual(["claude", "codex", "opencode"]);
    expect(updates).toHaveLength(3);
  });

  test("ignores environments with no recorded PIDs", async () => {
    const { options, updates, terminated } = makeOptions([
      environment({ id: "env-clean" }),
      environment({ id: "env-container", containerId: "abc123" }),
    ]);

    expect(await reapOrphanedLocalServers(options)).toEqual([]);
    expect(terminated).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("a failed record update does not abort the sweep", async () => {
    const environments = [
      environment({ id: "env-a", codexBridgePid: 401 }),
      environment({ id: "env-b", codexBridgePid: 402 }),
    ];
    const terminated: number[] = [];

    const reaped = await reapOrphanedLocalServers({
      storage: {
        loadEnvironments: async () => environments,
        updateEnvironment: async (environmentId: string) => {
          if (environmentId === "env-a") throw new Error("storage is busy");
        },
      },
      readIdentity: async (pid) => orphanedLeader(pid, COMMAND_LINES.codex),
      terminate: (async (child: { pid?: number }) => {
        if (child.pid) terminated.push(child.pid);
        return true;
      }) as never,
      log: () => undefined,
    });

    // Both were still killed; the storage failure is swallowed so one bad
    // record cannot leave the remaining orphans running.
    expect(terminated.sort()).toEqual([401, 402]);
    expect(reaped.map((entry) => entry.outcome)).toEqual(["reaped", "reaped"]);
  });
});

describe("parseProcessIdentity", () => {
  test("parses a typical `ps -o ppid=,pgid=,command=` row", () => {
    expect(parseProcessIdentity("    1  4242 /app/bin/bun /app/dist/index.js\n")).toEqual({
      parentPid: 1,
      processGroupId: 4242,
      commandLine: "/app/bin/bun /app/dist/index.js",
    });
  });

  test("keeps a command line containing whitespace runs and flags intact", () => {
    const stdout = "  501   900 /toolchains/opencode serve --port 5000 --hostname 127.0.0.1";
    expect(parseProcessIdentity(stdout)).toEqual({
      parentPid: 501,
      processGroupId: 900,
      commandLine: "/toolchains/opencode serve --port 5000 --hostname 127.0.0.1",
    });
  });

  test("returns null for empty, header-only, or malformed output", () => {
    expect(parseProcessIdentity("")).toBeNull();
    expect(parseProcessIdentity("\n\n   \n")).toBeNull();
    // A header row leaked in (the `=` suffixes failed to suppress it).
    expect(parseProcessIdentity(" PPID  PGID COMMAND")).toBeNull();
    // Missing the pgid column entirely.
    expect(parseProcessIdentity("1 /app/bin/bun")).toBeNull();
    // No command at all.
    expect(parseProcessIdentity("1 4242")).toBeNull();
  });

  test("skips leading blank lines rather than failing on them", () => {
    expect(parseProcessIdentity("\n\n 1 4242 /bin/sleep 100")).toMatchObject({
      parentPid: 1,
      processGroupId: 4242,
    });
  });
});

describe("isPidAlive", () => {
  test("sees this process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("sees a PID above pid_max as dead", () => {
    expect(isPidAlive(0x7fffffff)).toBe(false);
  });

  test("treats an unsignalable process as alive", () => {
    // PID 1 is launchd/init: it exists, but signalling it yields EPERM. Calling
    // that dead would let the reaper treat a live process as a stale record.
    expect(isPidAlive(1)).toBe(true);
  });
});

describe("detachedProcessHandle", () => {
  test("reports a live PID as not yet exited", () => {
    const handle = detachedProcessHandle(process.pid);
    expect(handle.pid).toBe(process.pid);
    expect(handle.exitCode).toBeNull();
    expect(handle.signalCode).toBeNull();
  });

  test("reports a PID that cannot exist as exited", () => {
    // `terminateProcessTree` polls `exitCode` to decide the tree is gone, so a
    // vanished orphan must read as exited rather than hanging the drain.
    expect(detachedProcessHandle(0x7fffffff).exitCode).toBe(0);
  });

  test("kill() reports false instead of throwing for a PID that cannot exist", () => {
    expect(detachedProcessHandle(0x7fffffff).kill("SIGTERM")).toBe(false);
  });

  test("kill() delivers signal 0 successfully to a live process", () => {
    // Signal 0 performs the permission/existence check without terminating.
    expect(detachedProcessHandle(process.pid).kill(0)).toBe(true);
  });
});
