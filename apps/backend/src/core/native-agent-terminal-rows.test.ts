/**
 * Terminal-state rows (`native-terminal:`) on both projection paths.
 *
 * The tab reads the progressive views, whose transcript read never sees
 * session state, so a failed turn's reason must travel on the state view; the
 * full projection keeps appending it to its messages. Both place the row with
 * the same rule (`@orkestrator/protocol/native-terminal-rows`).
 */
import { describe, expect, test } from "bun:test";
import { withNativeTerminalMessages } from "@orkestrator/protocol/native-terminal-rows";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const REFUSED =
  "unexpected status 401 Unauthorized: Incorrect API key provided: sk-fake***1234. You can find your API key at https://platform.openai.com/account/api-keys.";

const userRow = {
  id: "user-1",
  role: "user" as const,
  content: "hello",
  parts: [{ type: "text" as const, content: "hello" }],
  createdAt: "2026-10-27T00:00:00.000Z",
};

describe("native terminal rows", () => {
  test.each(["claude", "codex", "cursor", "grok", "pi"] as const)(
    "a failed %s turn's reason reaches the progressive state view",
    async (agent) => {
      const stub = createProviderStub(agent, {
        sessionStateSnapshot: async () => ({ status: "error", phase: "error", error: REFUSED }),
        transcriptSnapshot: async () => ({
          messages: [userRow],
          complete: true,
          freshness: "current" as const,
        }),
      });
      await withService(
        { prefix: `orkestrator-terminal-rows-${agent}-`, provider: async () => stub.provider },
        async ({ service }) => {
          const identity = {
            environmentId: "env-1",
            agent,
            logicalSessionKey: `env-env-1:tab-terminal-${agent}`,
          };
          await service.ensureSession(identity);
          const state = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
          if (state.status !== "snapshot") throw new Error("expected a state snapshot");
          expect(state.value.terminalMessages).toEqual([
            expect.objectContaining({
              id: expect.stringMatching(/^native-terminal:error:[0-9a-f]{16}$/),
              role: "system",
              content: REFUSED,
            }),
          ]);
          // `notices` still leaves terminal states to the rows.
          expect(state.value.notices.some((notice) => notice.kind === "error")).toBe(false);

          const transcript = await service.getTranscriptUpdate({
            ...identity,
            viewVersion: 1,
            liveWindow: { messages: 100, targetBytes: 512 * 1024 },
          });
          if (transcript.status !== "snapshot") throw new Error("expected a transcript snapshot");
          // The transcript itself stays the provider's rows only.
          expect(transcript.value.messages.map((row) => (row as { id: string }).id)).toEqual([
            "user-1",
          ]);
          const rendered = withNativeTerminalMessages(
            transcript.value.messages,
            state.value.terminalMessages,
          );
          expect(rendered.map((row) => (row as { content: string }).content)).toEqual([
            "hello",
            REFUSED,
          ]);
        },
      );
    },
  );

  test("an OpenCode error notice reaches the state view and defers to its inline row", async () => {
    const inline = {
      id: "error-opencode-assistant-failed",
      role: "assistant" as const,
      content: "Model request failed (HTTP 400): Bad Request",
      parts: [{ type: "text" as const, content: "Model request failed (HTTP 400): Bad Request" }],
      createdAt: "2026-10-27T00:00:01.000Z",
    };
    const stub = createProviderStub("opencode", {
      sessionStateSnapshot: async () => ({
        status: "error",
        phase: "error",
        notices: [
          { kind: "error", message: "Bad Request" },
          { kind: "error", message: "Connection lost while receiving events" },
        ],
      }),
      transcriptSnapshot: async () => ({
        messages: [userRow, inline],
        complete: true,
        freshness: "current" as const,
      }),
    });
    await withService(
      { prefix: "orkestrator-terminal-rows-opencode-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "env-env-1:tab-terminal-opencode",
        };
        await service.ensureSession(identity);
        const state = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        if (state.status !== "snapshot") throw new Error("expected a state snapshot");
        expect(state.value.terminalMessages).toHaveLength(2);
        const transcript = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow: { messages: 100, targetBytes: 512 * 1024 },
        });
        if (transcript.status !== "snapshot") throw new Error("expected a transcript snapshot");
        expect(
          withNativeTerminalMessages(transcript.value.messages, state.value.terminalMessages).map(
            (row) => (row as { content: string }).content,
          ),
        ).toEqual([
          "hello",
          "Model request failed (HTTP 400): Bad Request",
          "Connection lost while receiving events",
        ]);
      },
    );
  });

  test("the state view omits terminal rows once the turn error clears", async () => {
    let error: string | undefined = REFUSED;
    const stub = createProviderStub("codex", {
      sessionStateSnapshot: async () => ({
        status: error ? "error" : "idle",
        phase: error ? "error" : "idle",
        ...(error ? { error } : {}),
      }),
    });
    await withService(
      { prefix: "orkestrator-terminal-rows-clear-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-terminal-clear",
        };
        await service.ensureSession(identity);
        const failed = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
        if (failed.status !== "snapshot") throw new Error("expected a state snapshot");
        expect(failed.value.terminalMessages).toHaveLength(1);

        error = undefined;
        const next = await service.getSessionStateUpdate({
          ...identity,
          viewVersion: 1,
          knownToken: failed.token,
        });
        if (next.status !== "snapshot") throw new Error("the cleared error must move the token");
        expect(next.value.terminalMessages).toBeUndefined();
      },
    );
  });

  test("the full projection gives a Codex failure its status line, not a second row", async () => {
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "error",
        phase: "error",
        error: REFUSED,
        messages: [
          userRow,
          {
            id: "assistant-1",
            role: "assistant",
            content: "",
            parts: [{ type: "status", severity: "error", content: REFUSED }],
            createdAt: "2026-10-27T00:00:01.000Z",
          },
        ],
      }),
    });
    await withService(
      { prefix: "orkestrator-terminal-rows-codex-status-", provider: async () => stub.provider },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-terminal-codex-status",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.messages.map((row) => (row as { id: string }).id)).toEqual([
          "user-1",
          "assistant-1",
        ]);
      },
    );
  });
});
