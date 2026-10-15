import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeAgentService, nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { codexConnection, httpProvider } from "./agent-provider-test-support.js";
import {
  addEnvironment,
  createStorage,
  createProviderStub,
  refusingInvoke,
  withService,
} from "./native-agent-service-projection-test-support.js";

describe("backend approval control authority", () => {
  test.each(["claude", "codex"] as const)(
    "%s caps asking-policy choices and hides denying-policy controls",
    async (agent) => {
      for (const approvals of ["ask", "deny"] as const) {
        const stub = createProviderStub(agent, {
          interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
        });
        await withService(
          {
            prefix: "approval-policy-",
            provider: async () => stub.provider,
            environment: { agentSettings: { executionPolicy: { approvals } } },
          },
          async ({ service }) => {
            const identity = {
              environmentId: "env-1",
              agent,
              logicalSessionKey: "approval-policy",
            };
            await service.ensureSession(identity);
            const projection = await service.getProjection(identity);
            if (approvals === "deny") {
              expect(projection?.composer?.approvalModes).toBeUndefined();
              expect(projection?.composer?.selectedApprovalModeId).toBeUndefined();
              expect(
                projection?.composerControls.some((control) => control.id === "approval-mode"),
              ).toBe(false);
            } else {
              expect(
                projection?.composer?.approvalModes
                  ?.filter((mode) => mode.disabled)
                  .map((mode) => mode.id),
              ).toEqual(
                agent === "claude"
                  ? ["acceptEdits", "auto", "bypassPermissions"]
                  : ["auto-review", "never"],
              );
              await expect(
                service.updateProjectionControls({
                  ...identity,
                  update: { approvalMode: agent === "claude" ? "bypassPermissions" : "never" },
                }),
              ).rejects.toThrow("approval mode is invalid");
            }
          },
        );
      }
    },
  );

  test("approval-only updates through HttpBridgeProvider retain plan and fast mode", async () => {
    const config = {
      mode: "plan",
      fastMode: true,
      model: "gpt-5-codex",
      modelReasoningEffort: "high",
    };
    const { provider, requests } = httpProvider((url, init) => {
      if (url.endsWith("/session/create")) return Response.json({ sessionId: "codex-1" });
      if (url.endsWith("/config") && init.method === "POST") {
        // The Codex config endpoint replaces its config; an empty update is destructive.
        Object.assign(config, { mode: "build", fastMode: false }, JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      if (url.endsWith("/config")) return Response.json(config);
      if (url.endsWith("/messages")) return Response.json({ messages: [] });
      if (url.endsWith("/session/codex-1") || url.endsWith("/status"))
        return Response.json({
          status: "idle",
          messages: [],
          ...config,
          composer: {
            models: [{ platform: "codex", id: "gpt-5-codex", name: "Codex", supportsSpeed: true }],
            modes: [],
            fastModeAvailable: true,
            fastModeEnabled: true,
          },
        });
      return new Response(null, { status: 404 });
    }, codexConnection);
    await withService(
      {
        prefix: "approval-http-",
        provider: async () => provider,
        invoke: async <T>(command: string): Promise<T> => {
          if (command === "get_native_agent_model_catalog")
            return [
              {
                platform: "codex",
                id: "gpt-5-codex",
                label: "Codex",
                supportsSpeed: true,
              },
            ] as T;
          return refusingInvoke<T>(command);
        },
      },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "plan-fast",
        };
        await service.ensureSession({ ...identity, sessionMode: "plan", fastMode: true });
        const projection = await service.updateProjectionControls({
          ...identity,
          update: { approvalMode: "untrusted" },
        });
        expect(
          requests.filter((r) => r.url.endsWith("/config") && r.init.method === "POST"),
        ).toHaveLength(0);
        expect(config).toMatchObject({ mode: "plan", fastMode: true });
        expect(projection?.composer).toMatchObject({
          selectedModeId: "plan",
          fastModeEnabled: true,
          selectedApprovalModeId: "untrusted",
        });
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.controls).toMatchObject({
          mode: "plan",
          fastMode: true,
          approvalMode: "untrusted",
        });
      },
    );
  });

  test.each(["claude", "codex"] as const)(
    "%s launcher approval survives storage/service restart and inactive projections",
    async (agent) => {
      const directory = await mkdtemp(join(tmpdir(), "approval-restart-"));
      const stub = createProviderStub(agent, {
        interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      });
      const storage = await createStorage(directory);
      await addEnvironment(storage);
      const service = new NativeAgentService(storage, refusingInvoke, {
        provider: async () => stub.provider,
      });
      let restarted: NativeAgentService | undefined;
      const approvalMode = agent === "claude" ? "default" : "untrusted";
      const identity = { environmentId: "env-1", agent, logicalSessionKey: "launcher-approval" };
      try {
        expect(
          await service.dispatchIntent({
            ...identity,
            approvalMode,
            prompt: "First prompt",
            requestId: "launcher-first",
          }),
        ).toMatchObject({ outcome: "accepted" });
        expect(stub.send.mock.calls[0]?.[2]).toMatchObject({ approvalMode });
        const key = nativeAgentSessionStorageKey(
          identity.environmentId,
          agent,
          identity.logicalSessionKey,
        );
        expect((await storage.getNativeAgentSession(key))?.controls?.approvalMode).toBe(
          approvalMode,
        );
        await service.shutdown();
        const reloadedStorage = await createStorage(directory);
        restarted = new NativeAgentService(reloadedStorage, refusingInvoke, {
          provider: async () => stub.provider,
        });
        // Work progresses without a foreground projection or subscription.
        await restarted.dispatchPrompt({
          ...identity,
          prompt: "Continue while inactive",
          requestId: "inactive-next",
        });
        expect(stub.send.mock.calls.at(-1)?.[2]).toMatchObject({ approvalMode });
        expect((await restarted.getProjection(identity))?.composer?.selectedApprovalModeId).toBe(
          approvalMode,
        );
      } finally {
        await restarted?.shutdown();
        await service.shutdown();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
