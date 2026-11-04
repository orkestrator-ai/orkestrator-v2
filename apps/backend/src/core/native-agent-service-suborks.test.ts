/**
 * The native session's side of suborks: `/subork` goes to the current agent as
 * an instruction on every provider, Stop reaches the running calls, and the
 * rows are in the snapshot every view rehydrates from.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  parseSuborkRequestCarrier,
  SUBORK_TOOL_NAME,
  type NativeAgentSuborkBatchView,
} from "@orkestrator/protocol/suborks";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";

const BATCH: NativeAgentSuborkBatchView = {
  id: "batch-1",
  createdAt: "2026-11-04T00:00:00.000Z",
  status: "running",
  delivery: "waiting",
  suborks: [{ id: "s1", name: "Codex · GPT", agent: "codex", status: "running" }],
};

describe("/subork", () => {
  for (const agent of AGENT_PLATFORMS) {
    test(`on ${agent} is listed, and sends the agent an instruction to use the tool`, async () => {
      const stub = createProviderStub(agent, {
        interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
      });
      await withService(
        { prefix: "orkestrator-subork-command-", provider: async () => stub.provider },
        async ({ service }) => {
          const identity = {
            environmentId: "env-1",
            agent,
            logicalSessionKey: "env-env-1:tab",
          };
          await service.ensureSession(identity);
          const projection = await service.getProjection(identity);
          expect(projection?.slashCommands?.map((command) => command.name)).toContain("/subork");
          await service.dispatchPrompt({
            ...identity,
            prompt: "/subork ask codex to review this index.html",
            requestId: "request-1",
            command: { kind: "typed" },
          });
          const [, sent, options] = stub.send.mock.calls[0]!;
          // Literal text: no provider can read it as a command of its own.
          expect(sent.startsWith("<orkestrator-subork-request>")).toBe(true);
          expect(parseSuborkRequestCarrier(sent)).toEqual({
            request: "ask codex to review this index.html",
          });
          expect(sent).toContain(SUBORK_TOOL_NAME);
          expect(options.command).toBeUndefined();
        },
      );
    });
  }

  test("is refused outside an environment's agent tab, with why", async () => {
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService(
      { prefix: "orkestrator-subork-command-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "workflow-session",
        };
        await service.ensureSession(identity);
        await expect(
          service.dispatchPrompt({
            ...identity,
            prompt: "/subork ask codex to look",
            requestId: "request-1",
            command: { kind: "typed" },
          }),
        ).rejects.toThrow("agent tabs only");
        expect(stub.send).not.toHaveBeenCalled();
      },
    );
  });
});

describe("the session and its suborks", () => {
  test("rows are in the projection, and Stop reaches the running calls", async () => {
    const stopped: string[] = [];
    const identity = {
      environmentId: "env-1",
      agent: "claude" as const,
      logicalSessionKey: "env-env-1:tab",
    };
    const key = nativeAgentSessionStorageKey(
      identity.environmentId,
      identity.agent,
      identity.logicalSessionKey,
    );
    const stub = createProviderStub("claude", {
      interactiveSnapshot: async () => ({ status: "idle", messages: [] }),
    });
    await withService(
      {
        prefix: "orkestrator-subork-session-",
        provider: async () => stub.provider,
        suborks: {
          views: (sessionKey) => (sessionKey === key ? [BATCH] : undefined),
          stopForSession: async (sessionKey) => {
            stopped.push(sessionKey);
          },
          sweep: () => {},
        },
      },
      async ({ service }) => {
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.suborks).toEqual([BATCH]);
        await service.stopProjectionSession(identity);
        expect(stopped).toEqual([key]);
        await service.stopSuborksForSession(key);
        expect(stopped).toEqual([key, key]);
      },
    );
  });
});
