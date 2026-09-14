import { describe, expect, mock, test } from "bun:test";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerSystemCommands } from "./commands-registry-system.js";
import {
  boundSnapshot,
  collectDescendantPids,
  commandTouchesWorktree,
  environmentRootPids,
  MAX_CONCURRENT_CONTAINER_PROBES,
  MAX_PROCESSES_PER_ENVIRONMENT,
  MAX_SNAPSHOT_PROCESSES,
  parsePsUsageLines,
  readEnvironmentProcessUsage,
  sanitizeProcessCommand,
  selectLocalProcesses,
  summarizeListedProcesses,
  type EnvironmentProcessGroup,
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

const CLAUDE_BRIDGE_COMMAND = "/usr/bin/bun /opt/claude-bridge/dist/index.js --port 8000";

describe("environment process usage", () => {
  test("registers the environment process usage command", () => {
    const commands = new Map<string, CommandHandler>();
    registerSystemCommands((name, handler) => commands.set(name, handler));
    expect(commands.has("get_environment_process_usage")).toBe(true);
  });

  test("rejects unexpected arguments and loads every stored environment", async () => {
    const commands = new Map<string, CommandHandler>();
    const loadEnvironments = mock(async () => [environment({ id: "env-1", name: "alpha" })]);
    const snapshot = {
      environments: [],
      sampledAt: "2026-09-13T00:00:00.000Z",
      truncated: false,
    };
    const read = mock(async (_environments: ProcessUsageEnvironment[]) => snapshot);
    registerSystemCommands((name, handler) => commands.set(name, handler), undefined, read);

    await expect(
      commands.get("get_environment_process_usage")!({ extra: true }, {} as CommandContext),
    ).rejects.toThrow(/Unexpected arguments field: extra/);

    await commands.get("get_environment_process_usage")!({}, {
      storage: { loadEnvironments },
    } as unknown as CommandContext);
    expect(loadEnvironments).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith([environment({ id: "env-1", name: "alpha" })]);
  });

  test("rejects when stored environments cannot be loaded", async () => {
    const commands = new Map<string, CommandHandler>();
    registerSystemCommands((name, handler) => commands.set(name, handler));
    await expect(
      commands.get("get_environment_process_usage")!({}, {
        storage: {
          loadEnvironments: async () => {
            throw new Error("disk unavailable");
          },
        },
      } as unknown as CommandContext),
    ).rejects.toThrow(/disk unavailable/);
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

  test("keeps multicore CPU readings above 100 percent", () => {
    expect(parsePsUsageLines("  9   1 250.5  1.0  2048 /usr/bin/node --threads")[0]).toMatchObject({
      cpuPercent: 250.5,
      ramPercent: 1,
    });
  });

  test("redacts secret flags and caps command length", () => {
    expect(sanitizeProcessCommand("node server.js --token supersecret --cwd /private/home")).toBe(
      "node server.js --token *** --cwd /private/home",
    );
    expect(sanitizeProcessCommand("curl -H Authorization Bearer.secret https://api")).toBe(
      "curl -H Authorization *** https://api",
    );
    expect(sanitizeProcessCommand("tool --api-key=abcd1234")).toBe("tool --api-key=***");
    const oversized = `node ${"a".repeat(400)}`;
    const sanitized = sanitizeProcessCommand(oversized);
    expect(sanitized.endsWith("…")).toBe(true);
    expect(sanitized.length).toBe(241);
    expect(
      parsePsUsageLines("  8   1  1.0  1.0  100 node --token supersecret /work/env/app")[0]
        ?.command,
    ).toBe("node --token *** /work/env/app");
  });

  test("owns persisted roots, their descendants, and worktree argv matches", () => {
    const listed = parsePsUsageLines(
      [
        ` 10  1  1.0  1.0  100 ${CLAUDE_BRIDGE_COMMAND}`,
        " 11 10  8.0  2.0  200 /usr/bin/agent --cwd /work/env-a",
        " 12 11  0.5  0.4   50 /bin/zsh",
        " 20  1  3.0  1.0  300 bun /other/env-b/apps/web",
        " 21  1  0.0  0.0   10 /usr/bin/unrelated",
      ].join("\n"),
    );
    expect(
      environmentRootPids(environment({ id: "env-a", name: "a", claudeBridgePid: 10 })),
    ).toEqual([10]);
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

  test("matches worktree paths on token boundaries, including quotes and prefix collisions", () => {
    expect(commandTouchesWorktree("bun /work/env-2/app", "/work/env")).toBe(false);
    expect(commandTouchesWorktree("bun /work/env/app", "/work/env")).toBe(true);
    expect(commandTouchesWorktree('bun --cwd "/work/my env/src"', "/work/my env")).toBe(true);
    expect(commandTouchesWorktree("bun --cwd=/work/env", "/work/env")).toBe(true);
    expect(commandTouchesWorktree("bun --cwd=/work/env-2", "/work/env")).toBe(false);

    const listed = parsePsUsageLines(
      [
        " 30  1  1.0  1.0  100 bun /work/env/app",
        " 31  1  2.0  1.0  100 bun /work/env-2/app",
        ' 32  1  3.0  1.0  100 bun --cwd "/work/my env/src"',
      ].join("\n"),
    );
    expect(
      selectLocalProcesses(
        listed,
        environment({ id: "env", name: "env", worktreePath: "/work/env" }),
      ).map((process) => process.pid),
    ).toEqual([30]);
    expect(
      selectLocalProcesses(
        listed,
        environment({ id: "env-2", name: "env-2", worktreePath: "/work/env-2" }),
      ).map((process) => process.pid),
    ).toEqual([31]);
    expect(
      selectLocalProcesses(
        listed,
        environment({ id: "spaced", name: "spaced", worktreePath: "/work/my env" }),
      ).map((process) => process.pid),
    ).toEqual([32]);
  });

  test("drops a recycled root PID and its children when the command no longer matches", () => {
    const listed = parsePsUsageLines(
      [
        " 200  1  4.0  1.0  100 /usr/bin/vim notes.txt",
        " 201 200  8.0  2.0  200 /usr/bin/vim notes.txt.bak",
        " 202 201  1.0  0.5   50 /bin/cat notes.txt",
      ].join("\n"),
    );
    expect(
      environmentRootPids(
        environment({ id: "env-stale", name: "stale", claudeBridgePid: 200 }),
        listed,
      ),
    ).toEqual([]);
    expect(
      selectLocalProcesses(
        listed,
        environment({
          id: "env-stale",
          name: "stale",
          claudeBridgePid: 200,
          worktreePath: "/work/env-stale",
        }),
      ),
    ).toEqual([]);
  });

  test("keeps a recorded root only when its command still matches the server markers", () => {
    const listed = parsePsUsageLines(
      [` 200  1  4.0  1.0  100 ${CLAUDE_BRIDGE_COMMAND}`, " 201 200  1.0  0.5   50 /bin/zsh"].join(
        "\n",
      ),
    );
    expect(
      environmentRootPids(
        environment({ id: "env-live", name: "live", claudeBridgePid: 200 }),
        listed,
      ),
    ).toEqual([200]);
    expect(
      selectLocalProcesses(
        listed,
        environment({ id: "env-live", name: "live", claudeBridgePid: 200 }),
      ).map((process) => process.pid),
    ).toEqual([200, 201]);
  });

  test("caps each environment at the ranked process limit", () => {
    const rows = Array.from({ length: MAX_PROCESSES_PER_ENVIRONMENT + 12 }, (_, index) => {
      const cpu = (index + 1).toFixed(1);
      return ` ${100 + index}  1  ${cpu}  1.0  100 bun /tmp/local/worker-${index}`;
    });
    const listed = parsePsUsageLines(rows.join("\n"));
    const selected = selectLocalProcesses(
      listed,
      environment({ id: "busy", name: "busy", worktreePath: "/tmp/local" }),
    );
    expect(selected).toHaveLength(MAX_PROCESSES_PER_ENVIRONMENT);
    expect(selected[0]?.cpuPercent).toBe(MAX_PROCESSES_PER_ENVIRONMENT + 12);
    expect(selected.at(-1)?.cpuPercent).toBe(13);

    const summary = summarizeListedProcesses(listed);
    const extraCpu = Array.from({ length: 12 }, (_, index) => index + 1).reduce(
      (total, cpu) => total + cpu,
      0,
    );
    expect(summary.processCount).toBe(MAX_PROCESSES_PER_ENVIRONMENT + 12);
    expect(summary.truncated).toBe(true);
    expect(summary.processes).toHaveLength(MAX_PROCESSES_PER_ENVIRONMENT);
    expect(summary.totalCpuPercent).toBeGreaterThan(
      summary.processes.reduce((total, process) => total + process.cpuPercent, 0),
    );
    expect(summary.totalCpuPercent).toBe(
      summary.processes.reduce((total, process) => total + process.cpuPercent, 0) + extraCpu,
    );
    expect(summary.totalRssKb).toBe((MAX_PROCESSES_PER_ENVIRONMENT + 12) * 100);
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
        environment({
          id: "stopped",
          name: "stopped",
          status: "stopped",
          worktreePath: "/tmp/local",
        }),
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
    expect(snapshot.truncated).toBe(false);
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
    expect(snapshot.environments[0]).toMatchObject({
      totalCpuPercent: 2,
      totalRssKb: 100,
      processCount: 1,
      truncated: false,
    });
    expect(snapshot.environments[1]).toMatchObject({
      totalCpuPercent: 11,
      totalRssKb: 800,
      processCount: 1,
      truncated: false,
    });
    expect(snapshot.environments[2]).toMatchObject({
      totalCpuPercent: 0,
      totalRssKb: 0,
      processCount: 0,
      truncated: false,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith("ps", ["-axo", "pid=,ppid=,pcpu=,pmem=,rss=,args="], {
      timeoutMs: 2_000,
    });
    expect(execute).toHaveBeenCalledWith(
      "docker",
      ["exec", "ctr-1", "ps", "-eo", "pid=,ppid=,pcpu=,pmem=,rss=,args=", "--no-headers"],
      { timeoutMs: 2_000 },
    );
  });

  test("bounds concurrent container probes and oversized argv in the snapshot", async () => {
    let inFlight = 0;
    let peak = 0;
    const hugeArg = "x".repeat(8_000);
    const execute = mock(async (command: string, args: string[]) => {
      if (command !== "docker") throw new Error(`unexpected ${command}`);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return {
        stdout: `  ${args[1]?.replace("ctr-", "")}  1  1.0  1.0  100 node --token supersecret ${hugeArg}\n`,
      };
    });

    const snapshot = await readEnvironmentProcessUsage(
      Array.from({ length: 12 }, (_, index) =>
        environment({
          id: `ctr-${index}`,
          name: `box-${index}`,
          environmentType: "containerized",
          containerId: `ctr-${index}`,
        }),
      ),
      { platform: "linux", now: () => 0, runCommand: execute },
    );

    expect(peak).toBe(MAX_CONCURRENT_CONTAINER_PROBES);
    expect(execute).toHaveBeenCalledTimes(12);
    expect(JSON.stringify(snapshot).length).toBeLessThan(64_000);
    expect(snapshot.environments.some((group) => group.processes.length > 0)).toBe(true);
    for (const group of snapshot.environments) {
      for (const process of group.processes) {
        expect(process.command).not.toContain("supersecret");
        expect(process.command.length).toBeLessThanOrEqual(241);
      }
    }
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
    expect(snapshot.environments.every((group) => group.processCount === 0)).toBe(true);
    expect(snapshot.truncated).toBe(false);
  });

  test("keeps full-set totals when a snapshot drops rows past the process cap", async () => {
    const overflow = 5;
    const listedCount = MAX_PROCESSES_PER_ENVIRONMENT + overflow;
    const execute = mock(async (command: string) => {
      if (command !== "docker") throw new Error(`unexpected ${command}`);
      const rows = Array.from({ length: listedCount }, (_, index) => {
        const cpu = (index + 1).toFixed(1);
        return ` ${100 + index}  1  ${cpu}  1.0  250 bun /work/worker-${index}`;
      });
      return { stdout: `${rows.join("\n")}\n` };
    });

    const snapshot = await readEnvironmentProcessUsage(
      [
        environment({
          id: "heavy",
          name: "heavy",
          environmentType: "containerized",
          containerId: "ctr-heavy",
        }),
      ],
      { platform: "linux", now: () => 0, runCommand: execute },
    );

    const group = snapshot.environments[0]!;
    expect(group.processes).toHaveLength(MAX_PROCESSES_PER_ENVIRONMENT);
    expect(group.processCount).toBe(listedCount);
    expect(group.truncated).toBe(true);
    expect(snapshot.truncated).toBe(true);
    expect(group.totalCpuPercent).toBe(
      Array.from({ length: listedCount }, (_, index) => index + 1).reduce(
        (total, cpu) => total + cpu,
        0,
      ),
    );
    expect(group.totalRssKb).toBe(listedCount * 250);
    expect(group.processes.reduce((total, process) => total + process.cpuPercent, 0)).toBe(
      group.totalCpuPercent -
        Array.from({ length: overflow }, (_, index) => index + 1).reduce(
          (total, cpu) => total + cpu,
          0,
        ),
    );
  });

  test("preserves precomputed totals when boundSnapshot clips displayed rows", () => {
    const processRow = (pid: number) => ({
      pid,
      name: "node",
      command: "node",
      cpuPercent: 2,
      ramPercent: 1,
      rssKb: 100,
    });
    const group = (id: string, count: number): EnvironmentProcessGroup => ({
      environmentId: id,
      environmentName: id,
      projectId: "project-1",
      environmentType: "containerized",
      processes: Array.from({ length: count }, (_, index) => processRow(index + 1)),
      totalCpuPercent: 400,
      totalRssKb: 80_000,
      processCount: 80,
      truncated: true,
    });
    const environmentCount = Math.ceil((MAX_SNAPSHOT_PROCESSES + 40) / 40);
    const bounded = boundSnapshot(
      Array.from({ length: environmentCount }, (_, index) => group(`env-${index}`, 40)),
    );

    expect(bounded.truncated).toBe(true);
    expect(bounded.environments.reduce((total, item) => total + item.processes.length, 0)).toBe(
      MAX_SNAPSHOT_PROCESSES,
    );
    expect(bounded.environments.every((item) => item.totalCpuPercent === 400)).toBe(true);
    expect(bounded.environments.every((item) => item.totalRssKb === 80_000)).toBe(true);
    expect(bounded.environments.every((item) => item.processCount === 80)).toBe(true);
    expect(bounded.environments.some((item) => item.processes.length < 40)).toBe(true);
    expect(bounded.environments.every((item) => item.truncated)).toBe(true);
  });
});
