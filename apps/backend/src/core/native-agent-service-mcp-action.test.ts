import { collaborators, projectionInternals } from "./native-agent-service-test-collaborators.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
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
  test("discard an action finishing after session replacement", async () => {
    const action = Promise.withResolvers<{}>();
    const mcpServers = mock(async () => [server("old", "failed")]);
    const mcpServerAction = mock(() => action.promise);
    const stub = createProviderStub("claude");
    Object.assign(stub.provider, {
      mcpServers,
      mcpServerAction,
      resumeSession: async () => "replacement",
    });
    await withService(
      { prefix: "mcp-action-replace-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        const announced = spyOn(storage, "announceNativeAgentSessionProjection");
        const pending = service.performProjectionMcpAction({
          ...identity,
          serverId: "old",
          action: "reconnect",
        });
        await waitForCondition(() => mcpServerAction.mock.calls.length === 1);
        await service.resumeProjectionSession({ ...identity, providerSessionId: "replacement" });
        mcpServers.mockClear();
        announced.mockClear();
        action.resolve({});
        await pending;
        expect(mcpServers).not.toHaveBeenCalled();
        expect(announced).not.toHaveBeenCalledWith("env-1", "mcp-action", expect.anything());
      },
    );
  });

  test.each([false, true])(
    "deferred inventory survives prune, discards superseded result: %s",
    async (superseded) => {
      const inventory = Promise.withResolvers<NativeAgentMcpServer[]>();
      const mcpServers = mock(() => inventory.promise);
      const stub = createProviderStub("claude");
      Object.assign(stub.provider, { mcpServers, mcpServerAction: async () => ({}) });
      await withService(
        { prefix: "mcp-action-prune-", provider: async () => stub.provider },
        async ({ service, storage }) => {
          await service.ensureSession(identity);
          const view = projectionInternals(service);
          const projections = collaborators(service).projections;
          const key = nativeAgentSessionStorageKey(
            identity.environmentId,
            identity.agent,
            identity.logicalSessionKey,
          );
          const announced = spyOn(storage, "announceNativeAgentSessionProjection");
          const pending = service.performProjectionMcpAction({
            ...identity,
            serverId: "late",
            action: "reconnect",
          });
          await waitForCondition(() => mcpServers.mock.calls.length === 1);
          const epoch = view.projectionEpochs.get(key);
          view.pruneProjectionEpoch(key);
          expect(view.projectionEpochs.get(key)).toBe(epoch);
          if (superseded) projections.invalidateProjection(key);
          inventory.resolve([server("late", "connected")]);
          await pending;
          if (superseded) {
            expect(announced).not.toHaveBeenCalledWith("env-1", "mcp-action", expect.anything());
            expect(view.progressiveDiscoveryCache.size).toBe(0);
          } else {
            expect(announced).toHaveBeenCalledWith("env-1", "mcp-action", expect.anything());
            const update = await service.getDiscoveryUpdate(discoveryInput);
            expect(update.status === "snapshot" && update.value.sections.mcp?.value).toEqual([
              server("late", "connected"),
            ]);
          }
          expect(view.progressiveDirtyFollowUps.size).toBe(0);
        },
      );
    },
  );

  test("return a sign-in URL by the short deadline and ignore late inventory", async () => {
    const inventory = Promise.withResolvers<NativeAgentMcpServer[]>();
    let inventorySignal: AbortSignal | undefined;
    const stub = createProviderStub("claude");
    Object.assign(stub.provider, {
      mcpServers: (_sessionId: string, options?: { signal?: AbortSignal }) => {
        inventorySignal = options?.signal;
        return inventory.promise;
      },
      mcpServerAction: async () => ({ url: "https://example.test/login" }),
    });
    await withService(
      { prefix: "mcp-action-timeout-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        const announced = spyOn(storage, "announceNativeAgentSessionProjection");
        const started = Date.now();
        const result = await service.performProjectionMcpAction({
          ...identity,
          serverId: "late",
          action: "reconnect",
        });
        expect(result.url).toBe("https://example.test/login");
        expect(Date.now() - started).toBeLessThan(4_000);
        // The deadline ended the inventory request, not only the wait for it.
        expect(inventorySignal?.aborted).toBe(true);
        expect(announced).toHaveBeenCalledWith("env-1", "mcp-action", expect.anything());
        inventory.resolve([server("late", "connected")]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(projectionInternals(service).progressiveDiscoveryCache.size).toBe(0);
        expect(projectionInternals(service).progressiveReads.size).toBe(0);
      },
    );
  });

  test("announce even when the provider has no inventory reader", async () => {
    const stub = createProviderStub("claude");
    Object.assign(stub.provider, { mcpServerAction: async () => ({}) });
    await withService(
      { prefix: "mcp-action-no-reader-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        await service.ensureSession(identity);
        const announced = spyOn(storage, "announceNativeAgentSessionProjection");
        await service.performProjectionMcpAction({
          ...identity,
          serverId: "late",
          action: "reconnect",
        });
        expect(announced).toHaveBeenCalledWith("env-1", "mcp-action", expect.anything());
      },
    );
  });
});
