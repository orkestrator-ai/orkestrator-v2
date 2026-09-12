import { describe, expect, mock, test } from "bun:test";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerSystemCommands } from "./commands-registry-system.js";
import {
  collectDescendantPids,
  commandTouchesWorktree,
  environmentRootPids,
  parsePsUsageLines,
  readEnvironmentProcessUsage,
  selectLocalProcesses,
  type ProcessUsageEnvironment,
} from "./environment-process-usage.js";

function environment(
  overrides: Partial<ProcessUsageEnvironment> & Pick<ProcessUsageEnvironment, "id" | "name">,
): ProcessUsageEnvironment {
  return {
    projectId: "project-1",
    status: "running",
    environmentType: "local",
    ...overrides,
  };
}

describe("environment process usage", () => {
  test("registers the environment process usage command", () => {
    const commands = new Map<string, CommandHandler>();
    registerSystemCommands((name, handler) => commands.set(name, handler));
    expect(commands.has("get_environment_process_usage")).toBe(true);
  });

  test("rejects unexpected arguments and loads every stored environment", async () => {
    const commands = new Map<string, CommandHandler>();
    const loadEnvironments = mock(async () => [environment({ id: "env-1", name: "alpha" })]);
    const read = mock(async () => ({
      environments: [],
      sampledAt: "2026-09-13T00:00:00.000Z",
    }));
    registerSystemCommands(
      (name, handler) => commands.set(name, handler),
      undefined,
      async (environments) => read(environments),
    );

    await expect(
      commands.get("get_environment_process_usage")!({ extra: true }, {} as CommandContext),
    ).rejects.toThrow(/Unexpected arguments field: extra/);

    await commands.get("get_environment_process_usage")!({}, {
      storage: { loadEnvironments },
    } as unknown as CommandContext);
    expect(loadEnvironments).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith([environment({ id: "env-1", name: "alpha" })]);
  });

  test("parses ps rows and drops the listing process itself", () => {
    expect(
      parsePsUsageLines(
        [
          "  12   1  4.5  1.25  4096 /usr/bin/node --watch",
          "  44  12  0.0  0.0     80 ps -eo pid=",
          "not a process line",
          "  90   1  N/A  1.0   100 leftover",
        ].join("\n"),
      ),
    ).toEqual([
      {
        pid: 12,
        ppid: 1,
        name: "node",
        command: "/usr/bin/node --watch",
        cpuPercent: 4.5,
        ramPercent: 1.3,
        rssKb: 4096,
      },
    ]);
  });

  test("owns persisted roots, their descendants, and worktree argv matches", () => {
    const listed = parsePsUsageLines(
      [
        " 10  1  1.0  1.0  100 /usr/bin/bridge",
        " 11 10  8.0  2.0  200 /usr/bin/agent --cwd /work/env-a",
        " 12 11  0.5  0.4   50 /bin/zsh",
        " 20  1  3.0  1.0  300 bun /other/env-b/apps/web",
        " 21  1  0.0  0.0   10 /usr/bin/unrelated",
      ].join("\n"),
    );
    expect(environmentRootPids(environment({ id: "env-a", name: "a", claudeBridgePid: 10 }))).toEqual(
      [10],
    );
    expect(collectDescendantPids([10], listed)).toEqual(new Set([10, 11, 12]));
    expect(commandTouchesWorktree("bun /work/env-a/src", "/work/env-a")).toBe(true);
    expect(commandTouchesWorktree("bun /work/env-other", "/work/env-a")).toBe(false);

    expect(
      selectLocalProcesses(
        listed,
        environment({
          id: "env-a",
          name: "a",
          claudeBridgePid: 10,
          worktreePath: "/other/env-b",
        }),
      ).map((process) => process.pid),
    ).toEqual([11, 20, 10, 12]);
  });

  test("samples running containers and one shared host listing for local environments", async () => {
    const execute = mock(async (command: string, args: string[]) => {
      if (command === "ps") {
        return {
          stdout: [
            " 10  1  2.0  1.0  100 bun /tmp/local/app",
            " 11  1  0.0  0.0   10 /usr/bin/unrelated",
          ].join("\n"),
        };
      }
      if (command === "docker" && args[1] === "ctr-1") {
        return { stdout: "  7  1 11.0  4.0  800 /usr/local/bin/node server.js\n" };
      }
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    });

    const snapshot = await readEnvironmentProcessUsage(
      [
        environment({ id: "stopped", name: "stopped", status: "stopped", worktreePath: "/tmp/local" }),
        environment({
          id: "local-1",
          name: "local",
          worktreePath: "/tmp/local",
        }),
        environment({
          id: "ctr",
          name: "box",
          environmentType: "containerized",
          containerId: "ctr-1",
        }),
        environment({
          id: "missing-ctr",
          name: "ghost",
          environmentType: "containerized",
          containerId: null,
        }),
      ],
      {
        platform: "darwin",
        now: () => Date.parse("2026-09-13T00:00:00.000Z"),
        runCommand: execute,
      },
    );

    expect(snapshot.sampledAt).toBe("2026-09-13T00:00:00.000Z");
    expect(snapshot.environments.map((group) => group.environmentId)).toEqual([
      "local-1",
      "ctr",
      "missing-ctr",
    ]);
    expect(snapshot.environments[0]?.processes.map((process) => process.command)).toEqual([
      "bun /tmp/local/app",
    ]);
    expect(snapshot.environments[1]?.processes).toEqual([
      {
        pid: 7,
        name: "node",
        command: "/usr/local/bin/node server.js",
        cpuPercent: 11,
        ramPercent: 4,
        rssKb: 800,
      },
    ]);
    expect(snapshot.environments[2]?.processes).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      "ps",
      ["-axo", "pid=,ppid=,pcpu=,pmem=,rss=,args="],
      { timeoutMs: 2_000 },
    );
    expect(execute).toHaveBeenCalledWith(
      "docker",
      ["exec", "ctr-1", "ps", "-eo", "pid=,ppid=,pcpu=,pmem=,rss=,args=", "--no-headers"],
      { timeoutMs: 2_000 },
    );
  });

  test("survives a failed host or container probe instead of failing the snapshot", async () => {
    const snapshot = await readEnvironmentProcessUsage(
      [
        environment({ id: "local-1", name: "local", worktreePath: "/tmp/local" }),
        environment({
          id: "ctr",
          name: "box",
          environmentType: "containerized",
          containerId: "ctr-1",
        }),
      ],
      {
        platform: "linux",
        now: () => 0,
        runCommand: async (command) => {
          throw new Error(command === "ps" ? "ps missing" : "container gone");
        },
      },
    );
    expect(snapshot.environments).toHaveLength(2);
    expect(snapshot.environments.every((group) => group.processes.length === 0)).toBe(true);
  });
});
