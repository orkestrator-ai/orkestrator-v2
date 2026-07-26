import { describe, expect, test } from "bun:test";
import {
  reapOrphanedLocalServers,
  type ProcessIdentity,
} from "./local-server-reaper.js";
import type { Environment } from "./models.js";

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
        identities: new Map([
          [4242, { parentPid: 1, commandLine: "/app/bin/bun /app/codex-bridge/dist/index.js" }],
        ]),
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
          [200, { parentPid: 1, commandLine: "/usr/bin/vim notes.txt" }],
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
            commandLine: "/app/bin/bun /app/codex-bridge/dist/index.js",
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
        identities: new Map([
          [900, { parentPid: 1, commandLine: "/toolchains/opencode serve --port 5000" }],
        ]),
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
});
