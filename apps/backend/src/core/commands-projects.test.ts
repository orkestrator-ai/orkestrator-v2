import { describe, expect, mock, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import { refreshClaudeModelCatalog } from "./commands-projects.js";

describe("refreshClaudeModelCatalog", () => {
  test("passes the configured debug flag to a Docker Claude catalogue bridge", async () => {
    const startContainer = mock(async () => ({
      hostPort: 43123,
      wasRunning: false,
      authToken: "catalog-token",
    }));
    const updateEnvironment = mock(async () => undefined);
    const cacheAgentModelCatalog = mock(async () => undefined);
    const emitted: unknown[][] = [];
    const context = {
      storage: {
        getEnvironment: async () => ({
          id: "docker-env",
          environmentType: "docker",
          containerId: "container-123",
        }),
        loadConfig: async () => ({ global: { debugLogging: true } }),
        updateEnvironment,
        cacheAgentModelCatalog,
      },
      emit: (...args: unknown[]) => emitted.push(args),
    } as unknown as CommandContext;

    const snapshot = await refreshClaudeModelCatalog("docker-env", context, {
      enqueueContainerBridgeOperation: async (
        _agent: "claude",
        _containerId: string,
        operation: () => Promise<unknown>,
      ) => operation(),
      startContainerClaudeServer: startContainer,
      startLocalServer: async () => {
        throw new Error("local server should not start");
      },
      fetchClaudeBridgeModelCatalog: async () => ({
        models: [{ id: "claude-opus", name: "Claude Opus" }],
        source: "sdk",
        fetchedAt: "2026-09-09T00:00:00.000Z",
      }),
    } as never);

    expect(startContainer).toHaveBeenCalledWith("container-123", undefined, true);
    expect(snapshot).toMatchObject({
      environmentId: "docker-env",
      source: "sdk",
      stale: false,
    });
    expect(updateEnvironment).toHaveBeenCalledWith("docker-env", {
      claudeModelCatalog: snapshot,
    });
    expect(emitted).toContainEqual(["claude-model-catalog-updated", snapshot]);
  });
});
