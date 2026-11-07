import { eventSink } from "./backend-emit.js";
import { configureLogger, resetLogger, type LogOutput } from "@orkestrator/protocol/logger";
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
    const bridgeStarted = mock(() => undefined);
    const context = {
      storage: {
        getEnvironment: async () => ({
          id: "docker-env",
          environmentType: "docker",
          containerId: "container-123",
        }),
        loadConfig: async () => ({
          global: { debugLogging: true, claudeBackgroundCommandLimitHours: 6 },
        }),
        updateEnvironment,
        cacheAgentModelCatalog,
      },
      emit: eventSink((...args: unknown[]) => emitted.push(args)),
      runtime: { logPolicy: { bridgeStarted } },
    } as unknown as CommandContext;

    const fetchCatalog = mock(async () => ({
      models: [{ id: "claude-opus", name: "Claude Opus" }],
      source: "sdk",
      fetchedAt: "2026-09-09T00:00:00.000Z",
    }));
    const snapshot = await refreshClaudeModelCatalog(
      "docker-env",
      context,
      {
        enqueueContainerBridgeOperation: async (
          _context: unknown,
          _agent: "claude",
          _containerId: string,
          operation: () => Promise<unknown>,
        ) => operation(),
        containerCredentialMode: async () => "verifier",
        startContainerClaudeServer: startContainer,
        startLocalServer: async () => {
          throw new Error("local server should not start");
        },
        fetchClaudeBridgeModelCatalog: fetchCatalog,
      } as never,
      true,
    );
    expect(fetchCatalog).toHaveBeenCalledWith(43123, "catalog-token", true);

    expect(startContainer).toHaveBeenCalledWith("container-123", undefined, true, 6, "verifier");
    expect(bridgeStarted).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      environmentId: "docker-env",
      source: "sdk",
      stale: false,
    });
    expect(updateEnvironment).toHaveBeenCalledWith("docker-env", {
      claudeModelCatalog: snapshot,
    });
    expect(emitted).toContainEqual(["claude-model-catalog-updated", snapshot]);
    const logged: LogOutput[] = [];
    configureLogger({ sink: (output) => logged.push(output) });
    cacheAgentModelCatalog.mockRejectedValueOnce(new Error("cache unavailable"));
    try {
      const next = await refreshClaudeModelCatalog("docker-env", context, {
        enqueueContainerBridgeOperation: async (
          _context: unknown,
          _agent: "claude",
          _containerId: string,
          operation: () => Promise<unknown>,
        ) => operation(),
        containerCredentialMode: async () => "verifier",
        startContainerClaudeServer: startContainer,
        startLocalServer: async () => {
          throw new Error("unexpected local start");
        },
        fetchClaudeBridgeModelCatalog: fetchCatalog,
      } as never);
      expect(next.source).toBe("sdk");
      expect(logged.map((output) => output.record?.event)).toEqual(["cache.write-failed"]);
      expect(logged[0]!.record!.fields?.agent).toBe("claude");
    } finally {
      resetLogger();
    }
  });
});
