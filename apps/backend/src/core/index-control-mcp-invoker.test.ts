import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

/**
 * The composition root hands Control MCP an invoker over the backend's own
 * `invoke`. A tool call's signal must reach the command as its invocation's
 * signal (to-do 7543 task 6), and a call without one must add nothing.
 */
test("the Control MCP invoker forwards a call's signal to the backend's invoke", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-mcp-invoker-"));
  const backend = new OrkestratorBackend({
    dataDir,
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: {
      start: async () => undefined,
      stop: async () => undefined,
      connection: () => ({ url: "http://127.0.0.1:43210/mcp", token: "fixture" }),
      revokeEnvironment: () => undefined,
    },
    startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
  });
  const invoke = spyOn(backend, "invoke").mockResolvedValue("answer" as never);
  try {
    // The production ControlMcpServer, built by the constructor, and its invoker.
    const invoker = (backend as unknown as { controlMcp: { invoke: ControlMcpInvoker } }).controlMcp
      .invoke;
    const controller = new AbortController();
    expect(await invoker("get_machine_load", { a: 1 }, { signal: controller.signal })).toBe(
      "answer",
    );
    expect(await invoker("get_machine_load", { a: 2 })).toBe("answer");
    expect(await invoker("get_machine_load", { a: 3 }, {})).toBe("answer");
    expect(invoke.mock.calls).toEqual([
      ["get_machine_load", { a: 1 }, { signal: controller.signal }],
      ["get_machine_load", { a: 2 }],
      ["get_machine_load", { a: 3 }],
    ]);
  } finally {
    invoke.mockRestore();
    await backend.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
});
