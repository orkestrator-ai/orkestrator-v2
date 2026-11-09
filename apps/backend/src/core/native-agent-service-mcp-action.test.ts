import { describe, expect, mock, spyOn, test } from "bun:test";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";
import { nativeSessionInvalidationNamesDiscovery } from "@orkestrator/protocol/native-agent-observation";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";

/*
 * Todo 7221: a reconnect from the Agent Info panel brought a failed MCP
 * server up, the backend's projection said `connected`, and the open panel
 * kept the row failed. The action invalidated the projection but announced
 * nothing, so the view read discovery again only on its 30 s backstop, and
 * that read found the section dropped (`loading`, no value) and kept its row.
 */

function server(id: string, status: NativeAgentMcpServer["status"]): NativeAgentMcpServer {
  return { id, name: id, status, actions: ["reconnect"] };
}

const identity = {
  environmentId: "env-1",
  agent: "claude" as const,
  logicalSessionKey: "env-env-1:mcp-action",
};
const discoveryInput = { ...identity, viewVersion: 1 as const, sections: ["mcp" as const] };

describe("native agent MCP server actions", () => {
  test("store the re-read MCP list and announce it to views as a discovery change", async () => {
    let servers = [server("healthy", "connected"), server("late", "failed")];
    const mcpServers = mock(async () => servers);
    const mcpServerAction = mock(async () => {
      // The bridge updates its inventory before it answers the action.
      servers = [server("healthy", "connected"), server("late", "connected")];
      return {};
    });
    const stub = createProviderStub("claude");
    Object.assign(stub.provider, { mcpServers, mcpServerAction });
    await withService(
      { prefix: "orkestrator-mcp-action-refresh-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        const mcp = async () => {
          const update = await service.getDiscoveryUpdate(discoveryInput);
          if (update.status !== "snapshot") throw new Error("expected a discovery snapshot");
          return update.value.sections.mcp;
        };
        await mcp();
        await waitForCondition(async () => (await mcp())?.availability === "ready");
        expect((await mcp())?.value).toEqual([
          server("healthy", "connected"),
          server("late", "failed"),
        ]);

        const announced = spyOn(storage, "announceNativeAgentSessionProjection");
        await service.performProjectionMcpAction({
          ...identity,
          serverId: "late",
          action: "reconnect",
        });

        expect(mcpServerAction).toHaveBeenCalledWith("provider-session", "late", "reconnect");
        // Announced once the new list is stored, with a cause every view
        // reads discovery for.
        expect(announced).toHaveBeenCalledWith("env-1", "mcp-action", {
          agent: "claude",
          logicalSessionKey: identity.logicalSessionKey,
        });
        expect(nativeSessionInvalidationNamesDiscovery("mcp-action")).toBe(true);
        // The view's very next read has the acted-on row, settled: not an
        // empty `loading` section that leaves the old row on screen.
        const after = await mcp();
        expect(after?.availability).toBe("ready");
        expect(after?.value).toEqual([server("healthy", "connected"), server("late", "connected")]);
      },
    );
  });

  test("still announce when the re-read fails, so the view reads the section again", async () => {
    const mcpServers = mock(async (): Promise<NativeAgentMcpServer[]> => {
      throw new Error("bridge unavailable");
    });
    const mcpServerAction = mock(async () => ({}));
    const stub = createProviderStub("claude");
    Object.assign(stub.provider, { mcpServers, mcpServerAction });
    await withService(
      { prefix: "orkestrator-mcp-action-read-fails-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        const announced = spyOn(storage, "announceNativeAgentSessionProjection");
        await expect(
          service.performProjectionMcpAction({
            ...identity,
            serverId: "late",
            action: "reconnect",
          }),
        ).resolves.toEqual({});
        expect(announced).toHaveBeenCalledWith("env-1", "mcp-action", {
          agent: "claude",
          logicalSessionKey: identity.logicalSessionKey,
        });
      },
    );
  });

  test("leave the list alone when the action itself fails", async () => {
    const mcpServers = mock(async () => [server("late", "failed")]);
    const mcpServerAction = mock(async () => {
      throw new Error("MCP action failed");
    });
    const stub = createProviderStub("claude");
    Object.assign(stub.provider, { mcpServers, mcpServerAction });
    await withService(
      { prefix: "orkestrator-mcp-action-fails-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        const announced = spyOn(storage, "announceNativeAgentSessionProjection");
        await expect(
          service.performProjectionMcpAction({
            ...identity,
            serverId: "late",
            action: "reconnect",
          }),
        ).rejects.toThrow("MCP action failed");
        expect(mcpServers).not.toHaveBeenCalled();
        expect(announced).not.toHaveBeenCalledWith("env-1", "mcp-action", expect.anything());
      },
    );
  });
});
