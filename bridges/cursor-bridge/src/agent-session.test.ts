/**
 * Attaching, resuming, and replaying an existing agent's history.
 *
 * Resume is the path a user reaches through the session picker, and its replay
 * is best-effort by design — the model keeps its own context regardless of what
 * this transcript shows, so a history read that fails must still leave a
 * working session rather than a failed resume. That "degrade, never throw"
 * rule is only worth anything if it is actually exercised, which is what this
 * file does.
 *
 * `@cursor/sdk` is mocked with the snapshot-and-restore pattern so other suites
 * in this process keep the real module, and `agent-session.js` is imported
 * dynamically so it binds the mock.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realCursorSdk from "@cursor/sdk";

const realCursorSdkSnapshot = { ...realCursorSdk };

let apiKey: string | undefined = "test-key";
let listed: { items: unknown[] } = { items: [] };
let runs: { items: unknown[] } = { items: [] };
let listRunsFails = false;
let resumeFails = false;
const created: Array<Record<string, unknown>> = [];
const resumed: string[] = [];

function fakeSdkAgent(agentId: string) {
  return {
    agentId,
    send: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  };
}

mock.module("@cursor/sdk", () => ({
  ...realCursorSdkSnapshot,
  FileCredentialStore: class {
    async load() {
      return apiKey ? { apiKey } : undefined;
    }
  },
  Cursor: {
    ...(realCursorSdkSnapshot as { Cursor?: object }).Cursor,
    models: { list: async () => [] },
  },
  Agent: {
    create: async (options: Record<string, unknown>) => {
      created.push(options);
      return fakeSdkAgent("created-agent");
    },
    resume: async (agentId: string) => {
      resumed.push(agentId);
      if (resumeFails) throw new Error("no such agent");
      return fakeSdkAgent(agentId);
    },
    list: async () => listed,
    listRuns: async () => {
      if (listRunsFails) throw new Error("history unavailable");
      return runs;
    },
  },
}));

const { ensureAgent, listResumableSessions, newSessionState, resumeSession } =
  await import("./agent-session.js");
const { sessions } = await import("./state.js");

const previousApiKey = process.env.CURSOR_API_KEY;

beforeEach(() => {
  sessions.clear();
  apiKey = "test-key";
  listed = { items: [] };
  runs = { items: [] };
  listRunsFails = false;
  resumeFails = false;
  created.length = 0;
  resumed.length = 0;
  delete process.env.CURSOR_API_KEY;
});

afterAll(() => {
  sessions.clear();
  if (previousApiKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = previousApiKey;
  mock.module("@cursor/sdk", () => realCursorSdkSnapshot);
});

/** A conversation turn in the shape `run.conversation()` returns. */
function conversationRun(turns: unknown[], supports = true) {
  return {
    supports: () => supports,
    conversation: async () => turns,
  };
}

describe("ensureAgent", () => {
  test("refuses to attach without a credential, with a message naming the fix", async () => {
    apiKey = undefined;
    const state = newSessionState();
    expect(ensureAgent(state)).rejects.toThrow(/Settings/);
  });

  /**
   * Attach is reachable from the prompt route, the config route and the
   * explicit attach route, so two callers racing is ordinary rather than a
   * corner case. Without the shared in-flight promise each would see a null
   * agent and start a second one.
   */
  test("two concurrent callers share one attach", async () => {
    const state = newSessionState();
    const [first, second] = await Promise.all([ensureAgent(state), ensureAgent(state)]);
    expect(first).toBe(second);
    expect(created).toHaveLength(1);
  });

  test("a failed attach does not poison the next one", async () => {
    const state = newSessionState();
    apiKey = undefined;
    await ensureAgent(state).catch(() => undefined);
    apiKey = "test-key";
    await expect(ensureAgent(state)).resolves.toMatchObject({ agentId: "created-agent" });
  });

  test("resumes the agent id it already holds, keeping the model's own context", async () => {
    const state = newSessionState();
    state.agentId = "prior-agent";
    await ensureAgent(state);
    expect(resumed).toEqual(["prior-agent"]);
    expect(created).toHaveLength(0);
  });

  /**
   * The id may name an agent the store no longer has. A new agent carrying the
   * transcript we already hold is a far better outcome than a tab that can
   * never send again.
   */
  test("a resume that fails falls back to a new agent rather than failing the tab", async () => {
    const state = newSessionState();
    state.agentId = "gone";
    resumeFails = true;
    await expect(ensureAgent(state)).resolves.toMatchObject({ agentId: "created-agent" });
    expect(state.agentId).toBe("created-agent");
  });
});

describe("listResumableSessions", () => {
  test("is empty rather than an error when nothing is signed in", async () => {
    apiKey = undefined;
    expect(await listResumableSessions()).toEqual([]);
  });

  test("normalizes an entry onto the shared resume shape", async () => {
    listed = {
      items: [
        {
          agentId: "a1",
          name: "  Fix the parser  ",
          createdAt: 1_000,
          lastModified: 2_000,
          status: "running",
          summary: "  did things  ",
        },
      ],
    };
    expect(await listResumableSessions()).toEqual([
      {
        sessionId: "a1",
        title: "Fix the parser",
        createdAt: new Date(1_000).toISOString(),
        updatedAt: new Date(2_000).toISOString(),
        status: "running",
        detail: "did things",
      },
    ]);
  });

  test("maps an unrecognized status to idle rather than passing it through", async () => {
    listed = { items: [{ agentId: "a1", status: "something-new" }] };
    expect(await listResumableSessions()).toEqual([{ sessionId: "a1", status: "idle" }]);
  });
});

describe("resumeSession", () => {
  test("replays user text, assistant prose, reasoning and tool calls", async () => {
    runs = {
      items: [
        conversationRun([
          {
            type: "conversationTurn",
            turn: {
              userMessage: { text: "what changed?" },
              steps: [
                { type: "thinkingMessage", message: { text: "considering" } },
                { type: "assistantMessage", message: { text: "One file." } },
                {
                  type: "toolCall",
                  message: {
                    type: "read",
                    args: { path: "a.ts" },
                    result: { status: "success", value: { content: "body" } },
                  },
                },
              ],
            },
          },
        ]),
      ],
    };

    const state = await resumeSession("agent-1", undefined);

    expect(state.agentId).toBe("agent-1");
    expect(sessions.get(state.id)).toBe(state);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "what changed?" });

    const assistant = state.messages[1]!;
    // Only prose belongs in the flat body; reasoning is its own part and tool
    // calls are their own cards.
    expect(assistant.content).toBe("One file.");
    expect(assistant.parts.map((part) => part.type)).toEqual([
      "thinking",
      "text",
      "tool-invocation",
    ]);
    expect(assistant.parts[2]).toMatchObject({ toolName: "read", toolState: "success" });
  });

  test("settles replayed sub-agents rather than showing them as running", async () => {
    runs = {
      items: [
        conversationRun([
          {
            type: "conversationTurn",
            turn: {
              steps: [
                {
                  type: "toolCall",
                  message: {
                    type: "task",
                    args: { description: "audit" },
                    result: { status: "success", value: { isBackground: true } },
                  },
                },
              ],
            },
          },
        ]),
      ],
    };

    const state = await resumeSession("agent-1", undefined);
    // Replayed history is settled by definition: whatever these children were
    // doing, they are not doing it on this bridge's watch.
    expect(state.messages[0]!.parts[0]).toMatchObject({ agentState: "finished" });
    expect(state.activeSubagentDescriptors.size).toBe(0);
  });

  test("renders a shell turn from its own record", async () => {
    runs = {
      items: [
        conversationRun([
          {
            type: "shellConversationTurn",
            turn: {
              shellCommand: { command: "bun test" },
              shellOutput: { stdout: "ok" },
            },
          },
        ]),
      ],
    };

    const state = await resumeSession("agent-1", undefined);
    expect(state.messages[0]!.parts[0]).toMatchObject({
      toolName: "shell",
      toolState: "success",
    });
  });

  test("skips a run whose conversation the SDK says it cannot serve", async () => {
    runs = { items: [conversationRun([{ type: "conversationTurn", turn: {} }], false)] };
    const state = await resumeSession("agent-1", undefined);
    expect(state.messages).toEqual([]);
  });

  /**
   * A resumed conversation whose history could not be read is still a working
   * session, so a failed replay degrades to an empty transcript rather than a
   * failed resume.
   */
  test("a history read that throws still yields a usable session", async () => {
    listRunsFails = true;
    const state = await resumeSession("agent-1", undefined);
    expect(state.agentId).toBe("agent-1");
    expect(state.messages).toEqual([]);
    expect(sessions.get(state.id)).toBe(state);
  });

  test("a malformed turn is ignored rather than fatal", async () => {
    runs = {
      items: [conversationRun([null, "nonsense", { type: "conversationTurn" }, { turn: 7 }])],
    };
    const state = await resumeSession("agent-1", undefined);
    expect(state.messages).toEqual([]);
  });

  test("carries the caller's composer selection into the resumed session", async () => {
    const state = await resumeSession("agent-1", { modelId: "composer-2.5", modeId: "plan" });
    expect(state.composer.selectedModelId).toBe("composer-2.5");
    expect(state.composer.selectedModeId).toBe("plan");
  });
});
