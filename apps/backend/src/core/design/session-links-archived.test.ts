import { describe, expect, mock, test } from "bun:test";
import type { NativeAgentResumeEntry } from "@orkestrator/protocol/native-agent";
import { nativeAgentSessionStorageKey } from "../native-agent-service.js";
import {
  createProviderStub,
  withService,
} from "../native-agent-service-projection-test-support.js";
import {
  registerDesignCommandHandlers,
  type DesignCommandContext,
  type DesignCommandOptions,
} from "./commands.js";
import { DesignService } from "./service.js";
import { createTestRenderer } from "./test-support.js";

type Handler = (args: Record<string, unknown>, context: DesignCommandContext) => Promise<unknown>;

/**
 * A design link whose conversation the agent archived (to-do 0038 task 1):
 * the link state reads it from a running bridge's archived list, and Resume
 * restores it first only when asked to.
 */
async function withArchivedLink(
  agent: "claude" | "codex",
  behaviour: {
    list?: () => Promise<NativeAgentResumeEntry[]>;
    archive?: (id: string, archived: boolean) => Promise<void>;
    options?: Partial<DesignCommandOptions>;
  },
  run: (input: {
    command: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    args: Record<string, unknown>;
    order: string[];
    list: ReturnType<typeof mock>;
    archive: ReturnType<typeof mock>;
    resumeSession: ReturnType<typeof mock>;
  }) => Promise<void>,
) {
  const order: string[] = [];
  const stub = createProviderStub(agent);
  const list = mock(
    behaviour.list ??
      (async () => [
        { sessionId: "saved-identity", archived: true },
        { sessionId: "other-thread", archived: true },
        { sessionId: "live-thread" },
      ]),
  );
  const archive = mock(async (id: string, archived: boolean) => {
    order.push(`archive:${id}:${archived}`);
    await behaviour.archive?.(id, archived);
  });
  const resumeSession = mock(async (sessionId: string) => {
    order.push(`resume:${sessionId}`);
    return "resumed-live";
  });
  Object.assign(stub.provider, {
    listResumableSessions: list,
    setResumableSessionArchived: archive,
    resumeSession,
  });
  await withService(
    { prefix: "ork-design-archived-link-", provider: async () => stub.provider },
    async ({ service, storage }) => {
      const design = new DesignService(storage.getDataDir(), () => undefined, createTestRenderer());
      try {
        const commands = new Map<string, Handler>();
        registerDesignCommandHandlers((name, handler) => commands.set(name, handler), {
          nativeSessionKey: nativeAgentSessionStorageKey,
          ...behaviour.options,
        });
        const context = { design, storage, nativeAgents: service };
        const canvas = await design.create("env-1", "Linked", undefined, "user");
        const link = await design.linkSession("env-1", canvas.id, {
          tabId: "closed-tab",
          sessionId: "saved-identity",
          platform: agent,
          role: "design",
        });
        await run({
          command: (name, args) => commands.get(name)!(args, context),
          args: {
            environmentId: "env-1",
            canvasId: canvas.id,
            linkId: link.id,
            expectedTabId: "closed-tab",
            tabId: "resumed-tab",
          },
          order,
          list,
          archive,
          resumeSession,
        });
      } finally {
        await design.close();
      }
    },
  );
}

describe("design links to archived conversations", () => {
  test("a closed Codex link whose thread is archived reads as archived", async () => {
    await withArchivedLink("codex", {}, async ({ command, args, list }) => {
      expect(await command("design_session_link_states", args)).toMatchObject({
        ok: true,
        value: { states: [{ session: "missing", archived: true }] },
      });
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]?.[0]).toEqual({ includeArchived: true });
    });
  });

  test("a thread the list shows live, or does not list, is not archived", async () => {
    await withArchivedLink(
      "codex",
      { list: async () => [{ sessionId: "saved-identity" }, { sessionId: "x", archived: true }] },
      async ({ command, args }) => {
        const result = (await command("design_session_link_states", args)) as {
          value: { states: Array<Record<string, unknown>> };
        };
        expect(result.value.states).toEqual([{ linkId: args.linkId, session: "missing" }]);
      },
    );
  });

  test("a failed or slow archived list leaves the link resumable, never archived", async () => {
    await withArchivedLink(
      "codex",
      { list: async () => Promise.reject(new Error("bridge said no")) },
      async ({ command, args }) => {
        const result = (await command("design_session_link_states", args)) as {
          value: { states: Array<Record<string, unknown>> };
        };
        expect(result.value.states[0]).not.toHaveProperty("archived");
      },
    );
    await withArchivedLink(
      "codex",
      { list: () => new Promise(() => {}), options: { archivedReadDeadlineMs: 20 } },
      async ({ command, args }) => {
        const result = (await command("design_session_link_states", args)) as {
          ok: boolean;
          value: { states: Array<Record<string, unknown>> };
        };
        expect(result.ok).toBe(true);
        expect(result.value.states[0]).not.toHaveProperty("archived");
      },
    );
  });

  test("an agent that cannot archive is never asked", async () => {
    await withArchivedLink("claude", {}, async ({ command, args, list }) => {
      const result = (await command("design_session_link_states", args)) as {
        value: { states: Array<Record<string, unknown>> };
      };
      expect(result.value.states[0]).not.toHaveProperty("archived");
      expect(list).not.toHaveBeenCalled();
    });
  });

  test("Unarchive and resume restores the thread before resuming it", async () => {
    await withArchivedLink("codex", {}, async ({ command, args, order }) => {
      expect(
        await command("design_session_resume", { ...args, restoreArchived: true }),
      ).toMatchObject({
        ok: true,
        value: { link: { tabId: "resumed-tab" }, providerSessionId: "resumed-live" },
      });
      expect(order).toEqual(["archive:saved-identity:false", "resume:saved-identity"]);
    });
  });

  test("a plain Resume never writes archive state", async () => {
    await withArchivedLink("codex", {}, async ({ command, args, archive, resumeSession }) => {
      expect(await command("design_session_resume", args)).toMatchObject({ ok: true });
      expect(archive).not.toHaveBeenCalled();
      expect(resumeSession).toHaveBeenCalledTimes(1);
    });
  });

  test("a refused restore does not resume, and the link stays where it was", async () => {
    await withArchivedLink(
      "codex",
      {
        archive: async () => {
          throw new Error("Codex could not unarchive this conversation");
        },
      },
      async ({ command, args, resumeSession }) => {
        expect(
          await command("design_session_resume", { ...args, restoreArchived: true }),
        ).toMatchObject({
          ok: false,
          failure: { code: "disconnected", message: expect.stringContaining("unarchive") },
        });
        expect(resumeSession).not.toHaveBeenCalled();
        expect(await command("design_session_link_states", args)).toMatchObject({
          value: { sessions: [{ tabId: "closed-tab" }] },
        });
      },
    );
  });
});
