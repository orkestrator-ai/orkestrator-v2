import { describe, expect, mock, spyOn, test } from "bun:test";
import { BackendRuntime } from "../backend-runtime.js";
import { createCommandRegistry, type CommandContext } from "../commands.js";
import { nativeAgentSessionStorageKey } from "../native-agent-service.js";
import {
  createProviderStub,
  withService,
} from "../native-agent-service-projection-test-support.js";
import { registerDesignCommandHandlers, type DesignCommandContext } from "./commands.js";
import { DesignService } from "./service.js";
import { createTestRenderer } from "./test-support.js";

describe("design session commands with native service and storage", () => {
  test.each(["claude", "codex"] as const)(
    "%s resumes, records, and adopts the existing mapping",
    async (agent) => {
      const stub = createProviderStub(agent);
      const resumeSession = mock(async (_sessionId: string) => "resumed-live");
      Object.assign(stub.provider, { resumeSession });
      await withService(
        { prefix: "ork-design-native-command-", provider: async () => stub.provider },
        async ({ service, storage }) => {
          const design = new DesignService(
            storage.getDataDir(),
            () => undefined,
            createTestRenderer(),
          );
          try {
            const commands = new Map<
              string,
              (args: Record<string, unknown>, context: DesignCommandContext) => Promise<unknown>
            >();
            registerDesignCommandHandlers((name, handler) => commands.set(name, handler), {
              nativeSessionKey: nativeAgentSessionStorageKey,
            });
            const context = { design, storage, nativeAgents: service };
            const canvas = await design.create("env-1", "Linked", undefined, "user");
            const link = await design.linkSession("env-1", canvas.id, {
              tabId: "closed-tab",
              sessionId: "saved-identity",
              platform: agent,
              role: "design",
            });
            const args = {
              environmentId: "env-1",
              canvasId: canvas.id,
              linkId: link.id,
              expectedTabId: "closed-tab",
              tabId: "resumed-tab",
            };
            expect(await commands.get("design_session_link_states")!(args, context)).toMatchObject({
              ok: true,
              value: { states: [{ session: "missing" }] },
            });
            const result = await commands.get("design_session_resume")!(args, context);
            expect(result).toMatchObject({
              ok: true,
              value: { link: { tabId: "resumed-tab" }, providerSessionId: "resumed-live" },
            });
            expect(resumeSession.mock.calls[0]?.[0]).toBe("saved-identity");
            expect(
              (
                await storage.getNativeAgentSession(
                  nativeAgentSessionStorageKey("env-1", agent, "env-env-1:resumed-tab"),
                )
              )?.providerSessionId,
            ).toBe("resumed-live");
            expect(await commands.get("design_session_link_states")!(args, context)).toMatchObject({
              ok: true,
              value: { states: [{ session: "retained" }] },
            });
            // A stale client cannot move the retained conversation to another tab.
            expect(
              await commands.get("design_session_resume")!(
                { ...args, expectedTabId: "resumed-tab", tabId: "duplicate-tab" },
                context,
              ),
            ).toMatchObject({ ok: false, failure: { code: "conflict" } });
            expect(
              await commands.get("design_session_resume")!(
                { ...args, expectedTabId: "resumed-tab" },
                context,
              ),
            ).toEqual(result);
            expect(resumeSession).toHaveBeenCalledTimes(1);
          } finally {
            await design.close();
          }
        },
      );
    },
  );

  test("a retained tab without a saved identity is adopted through the real endpoint", async () => {
    const stub = createProviderStub("codex");
    const resumeSession = mock(async () => "must-not-resume");
    Object.assign(stub.provider, { resumeSession });
    await withService(
      { prefix: "ork-design-retained-no-identity-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const design = new DesignService(
          storage.getDataDir(),
          () => undefined,
          createTestRenderer(),
        );
        try {
          const commands = new Map<
            string,
            (args: Record<string, unknown>, context: DesignCommandContext) => Promise<unknown>
          >();
          registerDesignCommandHandlers((name, handler) => commands.set(name, handler), {
            nativeSessionKey: nativeAgentSessionStorageKey,
          });
          const context = { design, storage, nativeAgents: service };
          const canvas = await design.create("env-1", "Linked", undefined, "user");
          const link = await design.linkSession("env-1", canvas.id, {
            tabId: "in-use",
            platform: "codex",
            role: "design",
          });
          await service.ensureSession({
            environmentId: "env-1",
            agent: "codex",
            logicalSessionKey: "env-env-1:in-use",
          });
          const args = {
            environmentId: "env-1",
            canvasId: canvas.id,
            linkId: link.id,
            expectedTabId: "in-use",
            tabId: "in-use",
          };
          expect(await commands.get("design_session_link_states")!(args, context)).toMatchObject({
            ok: true,
            value: { states: [{ session: "retained" }] },
          });
          expect(
            await commands.get("design_session_resume")!({ ...args, tabId: "duplicate" }, context),
          ).toMatchObject({ ok: false, failure: { code: "conflict" } });
          expect(await commands.get("design_session_resume")!(args, context)).toMatchObject({
            ok: true,
            value: { providerSessionId: "provider-session", link: { tabId: "in-use" } },
          });
          expect(resumeSession).not.toHaveBeenCalled();
          expect(stub.createSession).toHaveBeenCalledTimes(1);
        } finally {
          await design.close();
        }
      },
    );
  });

  test("a Claude-preselected draft sent with Codex closes and resumes the Codex conversation", async () => {
    const stub = createProviderStub("codex", {
      sessionStateSnapshot: async () => ({ status: "idle", resumableSessionId: "codex-thread" }),
    });
    const resumeSession = mock(async (_sessionId: string) => "resumed-codex");
    Object.assign(stub.provider, { resumeSession });
    await withService(
      { prefix: "ork-design-provider-switch-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const design = new DesignService(
          storage.getDataDir(),
          () => undefined,
          createTestRenderer(),
        );
        try {
          const canvas = await design.create("env-1", "Linked", undefined, "user");
          const link = await design.linkSession("env-1", canvas.id, {
            tabId: "draft-tab",
            platform: "claude",
            role: "design",
          });
          await service.dispatchPrompt({
            environmentId: "env-1",
            agent: "codex",
            logicalSessionKey: "env-env-1:draft-tab",
            prompt: "Inspect the design",
            requestId: "first-send",
          });
          expect(stub.send).toHaveBeenCalledTimes(1);
          const commands = createCommandRegistry({
            tabTeardown: {
              peekBridge: async () => ({ port: 4000, authToken: "test" }),
              fetch: (async () =>
                Response.json({ closed: true, retained: true })) as unknown as typeof fetch,
            },
          });
          const context = {
            design,
            storage,
            nativeAgents: service,
            runtime: new BackendRuntime({ emit: () => undefined }),
          } as unknown as CommandContext;
          await commands.get("teardown_tab")!(
            { environmentId: "env-1", tabId: "draft-tab", kind: "codex-native" },
            context,
          );
          expect((await design.loadFor(canvas.id, "env-1")).record.sessions[0]).toMatchObject({
            platform: "codex",
            sessionId: "codex-thread",
          });
          expect(
            await commands.get("design_session_resume")!(
              {
                environmentId: "env-1",
                canvasId: canvas.id,
                linkId: link.id,
                expectedTabId: "draft-tab",
                tabId: "reopened-tab",
              },
              context,
            ),
          ).toMatchObject({
            ok: true,
            value: {
              providerSessionId: "resumed-codex",
              link: { platform: "codex", sessionId: "codex-thread" },
            },
          });
          expect(resumeSession.mock.calls[0]?.[0]).toBe("codex-thread");
        } finally {
          await design.close();
        }
      },
    );
  });

  test("a native resume that does not leave a mapping fails without moving the link", async () => {
    const stub = createProviderStub("codex");
    await withService(
      { prefix: "ork-design-unrecorded-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const design = new DesignService(
          storage.getDataDir(),
          () => undefined,
          createTestRenderer(),
        );
        const resume = spyOn(service, "resumeProjectionSession").mockResolvedValue(null);
        try {
          const commands = new Map<
            string,
            (args: Record<string, unknown>, context: DesignCommandContext) => Promise<unknown>
          >();
          registerDesignCommandHandlers((name, handler) => commands.set(name, handler), {
            nativeSessionKey: nativeAgentSessionStorageKey,
          });
          const canvas = await design.create("env-1", "Linked", undefined, "user");
          const link = await design.linkSession("env-1", canvas.id, {
            tabId: "old",
            sessionId: "saved",
            platform: "codex",
            role: "design",
          });
          expect(
            await commands.get("design_session_resume")!(
              {
                environmentId: "env-1",
                canvasId: canvas.id,
                linkId: link.id,
                expectedTabId: "old",
                tabId: "new",
              },
              { design, storage, nativeAgents: service },
            ),
          ).toMatchObject({
            ok: false,
            failure: { code: "disconnected", message: expect.stringContaining("not recorded") },
          });
          expect((await design.loadFor(canvas.id, "env-1")).record.sessions[0]?.tabId).toBe("old");
        } finally {
          resume.mockRestore();
          await design.close();
        }
      },
    );
  });
});
