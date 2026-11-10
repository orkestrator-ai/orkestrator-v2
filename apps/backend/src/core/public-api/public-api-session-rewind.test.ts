import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type { NativeAgentSessionAction } from "@orkestrator/protocol/native-agent";
import {
  encodePublicSessionId,
  nativeTabLogicalSessionKey,
} from "@orkestrator/protocol/public-api-resources";
import { providerCapabilities } from "./providers.js";
import { cleanupSessionHarnesses, setActivity, setup } from "./test-provider.js";

/**
 * `session.rewind`, `session.branches` and `session.branch`: the in-place
 * history actions the native tab offers, reachable from the CLI. Real storage,
 * the real native-agent service and a controlled provider; nothing spends
 * tokens.
 */

afterEach(cleanupSessionHarnesses);

const TAB_ID = "source-tab";
const PROVIDER_SESSION = "provider-session";

async function adoptedSession(
  agent: BuildPipelineAgent,
  provider: Record<string, unknown>,
  activity: "idle" | "working" = "idle",
) {
  const context = await setup(agent);
  const { harness, service, stub } = context;
  Object.assign(stub.provider, provider);
  stub.messages.push({
    id: "prompt-2",
    role: "user",
    createdAt: new Date(0).toISOString(),
    content: "prompt",
    parts: [],
  });
  stub.setStatus(async () => (activity === "idle" ? "idle" : "running"));
  await harness.storage.ensureNativeAgentJobTab({
    environmentId: "env-1",
    tabId: TAB_ID,
    agent,
    providerSessionId: PROVIDER_SESSION,
    activate: false,
  });
  await service.adoptSession({
    environmentId: "env-1",
    agent,
    logicalSessionKey: nativeTabLogicalSessionKey("env-1", TAB_ID),
    providerSessionId: PROVIDER_SESSION,
  });
  setActivity(service, agent, TAB_ID, PROVIDER_SESSION, activity);
  return { ...context, sessionId: encodePublicSessionId("env-1", TAB_ID) };
}

function recordingActions() {
  const actions: NativeAgentSessionAction[] = [];
  const performSessionAction = mock(
    async (_providerSessionId: string, action: NativeAgentSessionAction) => {
      actions.push(action);
      return { outcome: "applied" as const };
    },
  );
  return { actions, performSessionAction };
}

describe("session.rewind", () => {
  test.each(["codex", "pi", "cursor"] as const)(
    "%s rewinds before the prompt once per request ID",
    async (agent) => {
      const { actions, performSessionAction } = recordingActions();
      const { harness, sessionId } = await adoptedSession(agent, { performSessionAction });
      const first = await harness.call(
        "session.rewind",
        { sessionId, messageId: "prompt-2" },
        { requestId: "rewind-1" },
      );
      if (!first.ok) throw new Error(`rewind failed: ${first.error.message}`);
      expect(first.result).toEqual({ sessionId, rewoundBefore: "prompt-2" });
      expect(first.receipt?.state).toBe("succeeded");
      const replay = await harness.call(
        "session.rewind",
        { sessionId, messageId: "prompt-2" },
        { requestId: "rewind-1" },
      );
      expect(replay.ok).toBe(true);
      expect(actions).toEqual([{ kind: "rewind-messages", messageId: "prompt-2" }]);
      expect(performSessionAction.mock.calls[0]![0]).toBe(PROVIDER_SESSION);
    },
  );

  test.each(["pi", "codex", "cursor"] as const)(
    "%s refuses response and tool IDs without changing history",
    async (agent) => {
      const { actions, performSessionAction } = recordingActions();
      const { harness, sessionId, stub } = await adoptedSession(agent, { performSessionAction });
      stub.messages.push(
        {
          id: "answer",
          role: "assistant",
          createdAt: new Date(0).toISOString(),
          content: "response",
          parts: [],
        },
        {
          id: "tool-result",
          role: "assistant",
          createdAt: new Date(0).toISOString(),
          content: "result",
          parts: [],
        },
      );
      const original = structuredClone(stub.messages);
      for (const messageId of ["answer", "tool-result", "missing"]) {
        const refused = await harness.call(
          "session.rewind",
          { sessionId, messageId },
          { requestId: `refuse-${messageId}` },
        );
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error.code).toBe("invalid-input");
        expect(actions).toEqual([]);
        expect(stub.messages).toEqual(original);
      }
    },
  );

  test("a prompt outside the live transcript window is validated through history paging", async () => {
    const { actions, performSessionAction } = recordingActions();
    const { harness, sessionId, stub } = await adoptedSession("pi", { performSessionAction });
    harness.commands.set("get_native_agent_transcript_update", async () => ({
      status: "snapshot",
      token: "tail",
      value: {
        messages: [
          {
            id: "last-response",
            role: "assistant",
            content: "response",
            parts: [],
            createdAt: null,
          },
        ],
        freshness: "current",
        historyEpoch: "epoch",
        historyComplete: false,
        historyCursor: "older",
      },
    }));
    harness.commands.set("get_native_agent_message_page", async () => ({
      messages: stub.messages,
      historyEpoch: "epoch",
      complete: true,
    }));
    const result = await harness.call(
      "session.rewind",
      { sessionId, messageId: "prompt-2" },
      { requestId: "old-prompt" },
    );
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(result.ok).toBe(true);
    expect(actions).toEqual([{ kind: "rewind-messages", messageId: "prompt-2" }]);
  });

  test("a cached transcript cannot authorize rewind", async () => {
    const { actions, performSessionAction } = recordingActions();
    const { harness, sessionId, stub } = await adoptedSession("pi", { performSessionAction });
    harness.commands.set("get_native_agent_transcript_update", async () => ({
      status: "snapshot",
      value: {
        messages: stub.messages,
        freshness: "cached",
        historyEpoch: "epoch",
        historyComplete: true,
      },
    }));
    const refused = await harness.call(
      "session.rewind",
      { sessionId, messageId: "prompt-2" },
      { requestId: "cached" },
    );
    expect(refused.ok).toBe(false);
    expect(actions).toEqual([]);
  });

  test("a platform without message rewind is refused before admission", async () => {
    const { actions, performSessionAction } = recordingActions();
    const { harness, sessionId } = await adoptedSession("claude", { performSessionAction });
    const refused = await harness.call(
      "session.rewind",
      { sessionId, messageId: "prompt-2" },
      { requestId: "rewind-claude" },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("capability-unavailable");
    expect(actions).toEqual([]);
  });

  test("a running turn is a conflict and nothing reaches the provider", async () => {
    const { actions, performSessionAction } = recordingActions();
    const { harness, sessionId } = await adoptedSession(
      "codex",
      { performSessionAction },
      "working",
    );
    const refused = await harness.call(
      "session.rewind",
      { sessionId, messageId: "prompt-2" },
      { requestId: "rewind-busy" },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("conflict");
    expect(actions).toEqual([]);
  });

  test("the message ID is required", async () => {
    const { performSessionAction } = recordingActions();
    const { harness, sessionId } = await adoptedSession("codex", { performSessionAction });
    const refused = await harness.call("session.rewind", { sessionId }, { requestId: "no-id" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invalid-input");
  });

  test("a provider refusal fails the operation with its reason", async () => {
    const performSessionAction = mock(async () => {
      throw new Error("That message cannot be forked or rewound in this Pi session");
    });
    const { harness, sessionId } = await adoptedSession("pi", { performSessionAction });
    const failed = await harness.call(
      "session.rewind",
      { sessionId, messageId: "prompt-2" },
      { requestId: "rewind-refused" },
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.message).toContain("cannot be forked or rewound");
      expect(failed.receipt?.state).toBe("failed");
    }
  });
});

describe("session.branches and session.branch", () => {
  const list = {
    activeEntryId: "leaf-kept",
    branches: [{ entryId: "leaf-old", prompt: "second", entries: 4, updatedAt: "t" }],
    truncated: false,
  };

  test("Pi lists its other branches and switches to one", async () => {
    const { actions, performSessionAction } = recordingActions();
    const listSessionBranches = mock(async (_providerSessionId: string) => list);
    const { harness, sessionId } = await adoptedSession("pi", {
      performSessionAction,
      listSessionBranches,
    });
    const listed = await harness.call("session.branches", { sessionId });
    if (!listed.ok) throw new Error(`branches failed: ${listed.error.message}`);
    expect(listed.result).toEqual({
      activeEntryId: "leaf-kept",
      items: [{ id: "leaf-old", prompt: "second", entries: 4, updatedAt: "t" }],
      total: 1,
      truncated: false,
    });
    expect(listSessionBranches).toHaveBeenCalledWith(PROVIDER_SESSION);

    const switched = await harness.call(
      "session.branch",
      { sessionId, entryId: "leaf-old" },
      { requestId: "branch-1" },
    );
    if (!switched.ok) throw new Error(`branch failed: ${switched.error.message}`);
    expect(switched.result).toEqual({ sessionId, entryId: "leaf-old" });
    expect(actions).toEqual([{ kind: "switch-branch", entryId: "leaf-old" }]);
  });

  test.each(["codex", "cursor", "claude"] as const)("%s has no branches", async (agent) => {
    const { actions, performSessionAction } = recordingActions();
    const { harness, sessionId } = await adoptedSession(agent, { performSessionAction });
    const listed = await harness.call("session.branches", { sessionId });
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error.code).toBe("capability-unavailable");
    const switched = await harness.call(
      "session.branch",
      { sessionId, entryId: "leaf-old" },
      { requestId: `branch-${agent}` },
    );
    expect(switched.ok).toBe(false);
    if (!switched.ok) expect(switched.error.code).toBe("capability-unavailable");
    expect(actions).toEqual([]);
  });
});

describe("provider capabilities", () => {
  test("advertise rewind and branches from the native capability table", () => {
    expect(providerCapabilities("codex")).toMatchObject({ rewind: true, branches: false });
    expect(providerCapabilities("pi")).toMatchObject({ rewind: true, branches: true });
    expect(providerCapabilities("cursor")).toMatchObject({ rewind: true, branches: false });
    expect(providerCapabilities("claude")).toMatchObject({ rewind: false, branches: false });
  });
});
