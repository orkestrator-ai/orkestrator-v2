import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OrkestratorBackend } from "./index.js";
import { CoordinatorService } from "./coordinator-service.js";
import { seedStore } from "./storage-test-support.js";
import { NodeService } from "./nodes/node-service.js";

test("composition root connects node release and registry authority to coordinators", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ork-release-wiring-"));
  const remote = spyOn(CoordinatorService.prototype, "setRemoteAccess");
  const released = spyOn(CoordinatorService.prototype, "nodesReleased").mockResolvedValue();
  const ids = spyOn(NodeService.prototype, "registeredNodeIds").mockResolvedValue(
    new Set(["bk_leaf"]),
  );
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
  try {
    const adapter = remote.mock.calls.at(-1)![0];
    expect(await adapter.registeredNodeIds!()).toEqual(new Set(["bk_leaf"]));
    expect(ids).toHaveBeenCalledTimes(1);
    // Exercise the actual NodeService hook via forget's normal persisted path.
    seedStore(dataDir, "node-registry.json", {
      version: 1,
      registrationEnabled: true,
      nodes: [
        {
          nodeId: "bk_leaf",
          enabled: false,
          routes: [{ id: "https", kind: "https", enabled: true, origin: "https://leaf.test" }],
          addedAt: new Date().toISOString(),
        },
      ],
    });
    await backend.init();
    await backend.nodes.forgetNode({ nodeId: "bk_leaf" });
    expect(released).toHaveBeenCalled();
  } finally {
    await backend.shutdown();
    remote.mockRestore();
    released.mockRestore();
    ids.mockRestore();
    await rm(dataDir, { recursive: true, force: true });
  }
});
