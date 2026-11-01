import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNodeReadCommand } from "@orkestrator/protocol/command-nodes";
import {
  MACHINE_LOAD_COMMAND,
  parseMachineLoadReport,
  type MachineLoadReport,
} from "@orkestrator/protocol/machine-load";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerSystemCommands } from "./commands-registry-system.js";
import { COMPATIBILITY_PATH_IDS, compatibilityPathUsage } from "./compatibility-path-usage.js";
import { readNodeMachineLoad } from "./control-mcp-machine-load.js";
import { registerNodeTools } from "./control-mcp-nodes.js";
import { ControlMcpServer } from "./control-mcp-server.js";
import { rpc } from "./control-mcp-test-support.js";
import { coordinatorRoleCapabilities } from "./control-mcp-tools.js";
import { MachineLoadSampler } from "./machine-load.js";
import { NodeOutcomeUnknownError, NodeUnavailableError } from "./nodes/node-link.js";
import { isNodeExcludedCommand, isReadCommand, routeToNode } from "./nodes/node-routing.js";
import { flushMicrotasks } from "./recurring-test-support.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";

/**
 * `list_nodes` over the real Control MCP endpoint with a coordinator's
 * credential. This machine answers through the real `get_machine_load` command
 * and a sampler on a fake clock; the other nodes are fakes behind
 * `invoke_on_node`, in every state a coordinator can meet.
 */

const REMOTE: MachineLoadReport = {
  osFamily: "linux",
  os: "Arch Linux",
  arch: "x64",
  cpuCores: 32,
  totalRamGb: 128,
  latestSampleAgeSeconds: 12,
  load: [
    { window: "5m", windowSeconds: 300, coveredSeconds: 300, cpuPercent: 8, ramPercent: 21 },
    { window: "1h", windowSeconds: 3_600, coveredSeconds: 3_600, cpuPercent: 11, ramPercent: 22 },
    { window: "24h", windowSeconds: 86_400, coveredSeconds: 7_200, cpuPercent: 14, ramPercent: 25 },
  ],
};

function summary(nodeId: string, name: string, available = true) {
  return {
    nodeId,
    view: {
      displayName: name,
      connection: { state: available ? "connected" : "disconnected", remoteMode: "standalone" },
    },
    available,
    freshness: available ? "current" : "stale",
    projects: [],
    environments: [],
  };
}

describe("list_nodes over Control MCP", () => {
  let dataDir: string;
  let server: ControlMcpServer;
  let sampler: MachineLoadSampler;
  let clock: number;
  const routedCommands: string[] = [];

  /** Each fake node: its answer to `get_machine_load`, as a routed call would give it. */
  const answers = new Map<string, () => Promise<unknown>>();

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "orkestrator-machine-load-"));
    clock = Date.UTC(2026, 9, 31, 12);
    routedCommands.length = 0;
    answers.clear();
    let busy = 0;
    sampler = new MachineLoadSampler({
      now: () => clock,
      cpus: () => [
        {
          model: "secret-model-name",
          speed: 1,
          times: { user: busy, nice: 0, sys: 0, idle: busy * 3, irq: 0 },
        },
      ],
      arch: () => "arm64",
      totalMemory: () => 64 * 2 ** 30,
      readRam: async () => 40,
      platform: "darwin",
      runCommand: async () => ({ stdout: "26.1\n" }),
      metrics: new RecurringWorkMetrics({ enabled: false }),
      diagnostics: null,
    });
    await sampler.sample();
    for (let minute = 0; minute < 10; minute += 1) {
      clock += 60_000;
      busy += 60_000;
      await sampler.sample();
    }
    const commands = new Map<string, CommandHandler>();
    registerSystemCommands((name, handler) => commands.set(name, handler));
    const context = { machineLoad: sampler } as unknown as CommandContext;
    server = new ControlMcpServer(
      dataDir,
      async <T>(command: string, args: Record<string, unknown> = {}) => {
        switch (command) {
          case MACHINE_LOAD_COMMAND:
            return (await commands.get(command)!(args, context)) as T;
          case "get_config":
            return { global: {}, repositories: {} } as T;
          case "get_project_coordinator":
            return {
              workspace: {
                id: "coordinator-1",
                lifecycleState: "ready",
                conversations: [
                  {
                    id: "conversation-1",
                    tabId: "coordinator-tab",
                    mailboxIncarnationId: "incarnation-1",
                  },
                ],
              },
            } as T;
          case "get_node_status":
            return { nodeId: "bk_self", mode: "command", controllers: [] } as T;
          case "get_projects":
            return [{ id: "project-1", gitUrl: "git@github.com:acme/site.git" }] as T;
          case "get_node_summaries":
            return {
              selfId: "bk_self",
              nodes: [
                summary("bk_new", "Build box"),
                summary("bk_old", "Old box"),
                summary("bk_broken", "Broken box"),
                summary("bk_off", "Office Mac", false),
              ],
            } as T;
          case "invoke_on_node": {
            const nodeId = String(args.nodeId);
            routedCommands.push(`${nodeId}:${String(args.command)}`);
            const answer = answers.get(nodeId);
            if (!answer) throw new Error(`Unexpected node ${nodeId}`);
            return { outcome: "ok", result: await answer() } as T;
          }
          default:
            throw new Error(`Unknown backend command: ${command}`);
        }
      },
      { port: 0 },
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function listNodes(role: "main" | "side" = "main") {
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: coordinatorRoleCapabilities(role),
    });
    const { body } = await rpc(credential.url, credential.token, "tools/call", {
      name: "list_nodes",
      arguments: {},
    });
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeFalsy();
    return body.result!.structuredContent as {
      self: { nodeId: string; machine: Record<string, unknown> };
      nodes: Array<{ nodeId: string; name: string; machine: Record<string, unknown> }>;
    };
  }

  function answerAllHealthy() {
    answers.set("bk_new", async () => REMOTE);
    answers.set("bk_old", async () => {
      throw new Error(`Unknown backend command: ${MACHINE_LOAD_COMMAND}`);
    });
    answers.set("bk_broken", async () => ({ os: "no other fields" }));
  }

  const machineOf = (
    listed: Awaited<ReturnType<typeof listNodes>>,
    nodeId: string,
  ): Record<string, unknown> => listed.nodes.find((node) => node.nodeId === nodeId)!.machine;

  test("shows this machine, a remote node, an older node and an offline one", async () => {
    answerAllHealthy();
    const listed = await listNodes();

    expect(listed.self.machine).toEqual({
      status: "ok",
      osFamily: "macos",
      os: "macOS 26.1",
      arch: "arm64",
      cpuCores: 1,
      totalRamGb: 64,
      latestSampleAgeSeconds: 0,
      load: [
        { window: "5m", windowSeconds: 300, coveredSeconds: 300, cpuPercent: 25, ramPercent: 40 },
        { window: "1h", windowSeconds: 3_600, coveredSeconds: 600, cpuPercent: 25, ramPercent: 40 },
        {
          window: "24h",
          windowSeconds: 86_400,
          coveredSeconds: 600,
          cpuPercent: 25,
          ramPercent: 40,
        },
      ],
    });
    expect(machineOf(listed, "bk_new")).toEqual({ status: "ok", ...REMOTE });
    expect(machineOf(listed, "bk_old")).toMatchObject({
      status: "unavailable",
      reason: "older-version",
    });
    expect(machineOf(listed, "bk_broken")).toMatchObject({
      status: "unavailable",
      reason: "error",
    });
    expect(machineOf(listed, "bk_off")).toEqual({
      status: "unavailable",
      reason: "offline",
      detail: "Office Mac is not connected, so its load is unknown.",
    });

    // An offline node is never asked, and a machine with no figures shows none.
    expect(routedCommands).not.toContain(`bk_off:${MACHINE_LOAD_COMMAND}`);
    for (const nodeId of ["bk_old", "bk_broken", "bk_off"]) {
      expect(machineOf(listed, nodeId)).not.toHaveProperty("load");
    }
    // The read is routed, and only the read.
    expect(routedCommands.every((entry) => entry.endsWith(`:${MACHINE_LOAD_COMMAND}`))).toBe(true);
  });

  test("a side agent that can call list_nodes sees the same", async () => {
    for (const nodeId of ["bk_new", "bk_old", "bk_broken"]) {
      answers.set(nodeId, async () => REMOTE);
    }
    const listed = await listNodes("side");
    expect(listed.self.machine).toMatchObject({ status: "ok", os: "macOS 26.1" });
    expect(machineOf(listed, "bk_new")).toMatchObject({ status: "ok", os: "Arch Linux" });
  });

  test("carries no hostname, account, path or process details", async () => {
    answers.set("bk_new", async () => ({
      ...REMOTE,
      hostname: "secret-host",
      homedir: "/home/secret-user",
      processes: ["secret-process"],
    }));
    answers.set("bk_old", async () => {
      throw new Error("ENOENT /home/secret-user/.config on secret-host");
    });
    answers.set("bk_broken", async () => REMOTE);
    const listed = await listNodes();
    expect(JSON.stringify(listed)).not.toContain("secret");
    expect(machineOf(listed, "bk_old")).toMatchObject({ reason: "error" });
  });

  test("the whole payload stays small enough to read before every placement", async () => {
    answerAllHealthy();
    const listed = await listNodes();
    const perMachine = Buffer.byteLength(JSON.stringify(machineOf(listed, "bk_new")));
    expect(perMachine).toBeLessThan(600);
  });
});

describe("list_nodes with a node that never answers", () => {
  test("returns the other machines, and reports the hung one as timed out", async () => {
    const tools = new Map<string, () => Promise<{ structuredContent: Record<string, unknown> }>>();
    const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      switch (command) {
        case "get_node_status":
          return { nodeId: "bk_self", mode: "command", controllers: [] } as T;
        case "get_projects":
          return [] as T;
        case "get_node_summaries":
          return {
            selfId: "bk_self",
            nodes: [summary("bk_new", "Build box"), summary("bk_hung", "Hung box")],
          } as T;
        case MACHINE_LOAD_COMMAND:
          return REMOTE as T;
        case "invoke_on_node":
          if (args.nodeId === "bk_hung") return new Promise<T>(() => undefined);
          return { outcome: "ok", result: REMOTE } as T;
        default:
          throw new Error(`Unexpected command ${command}`);
      }
    };
    registerNodeTools(
      {
        registerTool: (name: string, _config: unknown, handler: never) => tools.set(name, handler),
      } as never,
      invoke,
      { projectId: "project-1", coordinatorId: "c1", conversationId: "conv-1" },
      { machineLoadTimeoutMs: 5 },
    );
    const { structuredContent } = await tools.get("list_nodes")!();
    expect(structuredContent).toMatchObject({
      self: { machine: { status: "ok" } },
      nodes: [
        { nodeId: "bk_new", machine: { status: "ok", os: "Arch Linux" } },
        {
          nodeId: "bk_hung",
          available: true,
          machine: { status: "unavailable", reason: "timeout" },
        },
      ],
    });
  });
});

describe("reading one node's load", () => {
  const node = { nodeId: "bk_leaf", name: "Build box", available: true };

  test("a node that hangs is reported as timed out", async () => {
    const view = await readNodeMachineLoad(
      (async () => new Promise(() => undefined)) as never,
      node,
      5,
    );
    expect(view).toEqual({
      status: "unavailable",
      reason: "timeout",
      detail: "Build box did not report its load within 5 ms.",
    });
  });

  test("a rejection after the timeout is handled, not an unhandled rejection", async () => {
    const late = Promise.withResolvers<never>();
    const view = await readNodeMachineLoad((() => late.promise) as never, node, 1);
    expect(view).toMatchObject({ reason: "timeout" });
    late.reject(new Error("gone"));
    await flushMicrotasks();
  });

  test("only the unknown-command answer means an older node, and it is counted", async () => {
    const before = compatibilityPathUsage.snapshot().paths["machine-load.older-node"]?.count ?? 0;
    const view = await readNodeMachineLoad(
      (async () => {
        throw new Error(unknownBackendCommandMessage(MACHINE_LOAD_COMMAND));
      }) as never,
      node,
    );
    expect(view).toMatchObject({ reason: "older-version" });
    expect(compatibilityPathUsage.snapshot().paths["machine-load.older-node"]?.count).toBe(
      before + 1,
    );
    expect(COMPATIBILITY_PATH_IDS).toContain("machine-load.older-node");

    // No backend has answered "Unknown command:", and a longer name is another command.
    for (const wording of [
      "Network down",
      `Unknown command: ${MACHINE_LOAD_COMMAND}`,
      "Unknown backend command: something_else",
      `Unknown backend command: ${MACHINE_LOAD_COMMAND}_v2`,
    ]) {
      const view = await readNodeMachineLoad(
        (async () => {
          throw new Error(wording);
        }) as never,
        node,
      );
      expect(view).toMatchObject({ reason: "error" });
    }
    expect(compatibilityPathUsage.snapshot().paths["machine-load.older-node"]?.count).toBe(
      before + 1,
    );
  });

  test("a link that drops after the summaries were read is offline", async () => {
    const view = await readNodeMachineLoad(
      (async () => {
        throw new NodeUnavailableError("not connected");
      }) as never,
      node,
    );
    expect(view).toEqual({
      status: "unavailable",
      reason: "offline",
      detail: "Build box is not connected, so its load is unknown.",
    });
  });

  test("a lost answer is reported as lost, without figures", async () => {
    const view = await readNodeMachineLoad(
      (async () => ({ outcome: "unknown", requestKey: "k", outcomeId: "o" })) as never,
      node,
    );
    expect(view).toEqual({
      status: "unavailable",
      reason: "error",
      detail: "The connection to Build box was lost before it answered.",
    });
  });
});

describe("routing get_machine_load", () => {
  test("is a read, and may cross the node link", () => {
    expect(isNodeReadCommand(MACHINE_LOAD_COMMAND)).toBe(true);
    expect(isReadCommand(MACHINE_LOAD_COMMAND)).toBe(true);
    expect(isNodeExcludedCommand(MACHINE_LOAD_COMMAND)).toBe(false);
  });

  test("a read whose answer is lost is not recorded as an unknown write", async () => {
    const recorded: unknown[] = [];
    await expect(
      routeToNode({
        nodeId: "bk_leaf" as never,
        link: {
          connected: true,
          invoke: async () => {
            throw new NodeOutcomeUnknownError("lost");
          },
        },
        command: MACHINE_LOAD_COMMAND,
        args: {},
        outcomes: {
          record: async (entry: unknown) => {
            recorded.push(entry);
            return { outcomeId: "o" };
          },
        } as never,
      }),
    ).rejects.toThrow("lost");
    expect(recorded).toEqual([]);
  });
});

describe("parsing a node's answer", () => {
  const valid = REMOTE;

  test("keeps a valid answer, including a newer node's other windows", () => {
    expect(parseMachineLoadReport(valid)).toEqual(valid);
    const newer = {
      ...valid,
      load: [
        { window: "7d", windowSeconds: 604_800, coveredSeconds: 1, cpuPercent: 1, ramPercent: 1 },
      ],
    };
    expect(parseMachineLoadReport(newer)?.load[0]?.window).toBe("7d");
  });

  test("refuses the wrong shape", () => {
    for (const bad of [
      null,
      "text",
      {},
      { ...valid, osFamily: "beos" },
      { ...valid, os: "" },
      { ...valid, cpuCores: -1 },
      { ...valid, latestSampleAgeSeconds: "soon" },
      { ...valid, load: "none" },
      { ...valid, load: [{ ...valid.load[0], cpuPercent: 101 }] },
      { ...valid, load: [{ ...valid.load[0], window: "not a window" }] },
      { ...valid, load: Array.from({ length: 9 }, () => valid.load[0]) },
    ]) {
      expect(parseMachineLoadReport(bad)).toBeNull();
    }
  });

  test("bounds the strings it keeps", () => {
    const parsed = parseMachineLoadReport({ ...valid, os: "x".repeat(500), arch: "y".repeat(99) });
    expect(parsed?.os).toHaveLength(120);
    expect(parsed?.arch).toHaveLength(32);
  });
});
