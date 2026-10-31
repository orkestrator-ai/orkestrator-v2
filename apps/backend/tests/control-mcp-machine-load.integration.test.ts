import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NodeView } from "@orkestrator/protocol/command-nodes";
import { MACHINE_LOAD_COMMAND, type MachineLoadReport } from "@orkestrator/protocol/machine-load";
import { requestUrl, startGateway } from "./gateway-test-harness.js";
import { readNodeMachineLoad } from "../src/core/control-mcp-machine-load.js";
import { OrkestratorBackend } from "../src/core/index.js";
import type { MachineLoadSampler } from "../src/core/machine-load.js";

function backend(dataDir: string) {
  return new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: {
      start: async () => undefined,
      stop: async () => undefined,
      connection: () => ({ url: "http://127.0.0.1:43210/mcp", token: "test-token" }),
      revokeEnvironment: () => undefined,
    },
    startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
  });
}

test("production lifecycle wires, starts and stops the command's sampler", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-machine-load-lifecycle-"));
  const instance = backend(dataDir);
  const internals = instance as unknown as {
    machineLoad: MachineLoadSampler;
    context: { machineLoad: MachineLoadSampler };
  };
  const sampler = internals.machineLoad;
  const start = spyOn(sampler, "start");
  const stop = spyOn(sampler, "stop");
  const report = spyOn(sampler, "report");
  try {
    expect(internals.context.machineLoad).toBe(sampler);
    expect(start).not.toHaveBeenCalled();
    await instance.init();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    const answer = await instance.invoke<MachineLoadReport>(MACHINE_LOAD_COMMAND);
    expect(report).toHaveBeenCalledTimes(1);
    expect(answer).toEqual(sampler.report());
    await instance.shutdown();
    expect(stop).toHaveBeenCalledTimes(1);
    await instance.shutdown();
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    await instance.shutdown();
    start.mockRestore();
    stop.mockRestore();
    report.mockRestore();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("machine load crosses two real backends, their portal, link and gateways", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-machine-load-routing-"));
  const command = backend(path.join(dataDir, "command"));
  const leaf = backend(path.join(dataDir, "leaf"));
  try {
    await command.init();
    await leaf.init();
    const remote = await startGateway({
      backend: leaf,
      backendHello: () => leaf.backendHelloIdentity(),
      nodeHooks: leaf.nodeGateway(),
    });
    await command.invoke("set_command_node_enabled", { enabled: true });
    const attached = await command.invoke<NodeView>("add_node", {
      routes: [
        { id: "primary", kind: "https", enabled: true, origin: new URL(remote.info.url).origin },
      ],
      token: remote.info.token,
    });
    expect(attached.connection.state).toBe("connected");
    const local = await startGateway({
      backend: command,
      backendHello: () => command.backendHelloIdentity(),
      nodeHooks: command.nodeGateway(),
    });
    // This is an HTTP client of the command gateway, with no routing stubs.
    const invoke = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const response = await requestUrl(
        new URL("/__orkestrator/invoke", local.info.url).toString(),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${local.info.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ command: name, args }),
        },
      );
      const payload = response.json() as { result: T; error?: string; code?: string };
      if (response.status !== 200)
        throw Object.assign(new Error(payload.error), { code: payload.code });
      return payload.result;
    };
    const node = { nodeId: attached.nodeId, name: "Build box", available: true };
    const expected = await leaf.invoke<MachineLoadReport>(MACHINE_LOAD_COMMAND);
    expect(await readNodeMachineLoad(invoke, node)).toEqual({ status: "ok", ...expected });

    // Only the leaf's command availability changes, as on an older backend.
    const realInvoke = leaf.invoke.bind(leaf);
    const older = spyOn(leaf, "invoke").mockImplementation(async (name, args) => {
      if (name === MACHINE_LOAD_COMMAND) throw new Error(`Unknown backend command: ${name}`);
      return realInvoke(name, args);
    });
    try {
      expect(await readNodeMachineLoad(invoke, node)).toMatchObject({
        status: "unavailable",
        reason: "older-version",
      });
    } finally {
      older.mockRestore();
    }

    // The link still believes it is connected, but its request gets no answer.
    await remote.gateway.stop();
    await expect(
      invoke("invoke_on_node", {
        nodeId: node.nodeId,
        command: MACHINE_LOAD_COMMAND,
        args: {},
      }),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
    const lost = await readNodeMachineLoad(invoke, node);
    expect(lost).toEqual({
      status: "unavailable",
      reason: "error",
      detail: "Build box could not report its load.",
    });
    expect(lost).not.toHaveProperty("load");
    expect(await command.invoke("list_node_outcomes", { nodeId: node.nodeId })).toEqual([]);
  } finally {
    await command.shutdown();
    await leaf.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
