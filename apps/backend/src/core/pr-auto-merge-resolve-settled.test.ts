import { describe, expect, test } from "bun:test";
import type { PersistedNativeAgentSession, PersistedPromptQueue } from "./models.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { resolveConversationBusy, resolveTabsSettled } from "./pr-auto-merge-resolve-settled.js";

const ENV = "env-1";
const RESOLVE_TAB = "agent-job-resolve";
const OTHER_TAB = "agent-tab-other";
const logicalKey = (tabId: string) => `env-${ENV}:${tabId}`;

function session(
  overrides: Partial<PersistedNativeAgentSession> = {},
): PersistedNativeAgentSession {
  return {
    key: "key",
    environmentId: ENV,
    agent: "claude",
    logicalSessionKey: logicalKey(RESOLVE_TAB),
    providerSessionId: "provider-1",
    dispatchedRequestIds: ["resolve-1"],
    ...overrides,
  } as PersistedNativeAgentSession;
}

function queue(overrides: Partial<PersistedPromptQueue> = {}): PersistedPromptQueue {
  return {
    queueKey: `claude\0${logicalKey(RESOLVE_TAB)}`,
    environmentId: ENV,
    messages: [],
    ...overrides,
  } as PersistedPromptQueue;
}

const settledTurn = {
  providerSessionId: "provider-1",
  requestId: "resolve-1",
  state: "settled" as const,
};

describe("resolveConversationBusy", () => {
  test("a conversation with nothing dispatched is idle", () => {
    expect(resolveConversationBusy(null, null)).toBe(false);
    expect(resolveConversationBusy(session({ dispatchedRequestIds: [] }), queue())).toBe(false);
  });

  test("the latest turn is busy until an outcome or a settled checkpoint names it", () => {
    expect(resolveConversationBusy(session(), queue())).toBe(true);
    expect(
      resolveConversationBusy(
        session({
          turnOutcomes: [
            { requestId: "resolve-1", outcome: "completed", observedAt: new Date().toISOString() },
          ],
        } as Partial<PersistedNativeAgentSession>),
        queue(),
      ),
    ).toBe(false);
    expect(resolveConversationBusy(session({ activityTurn: settledTurn }), queue())).toBe(false);
    // A checkpoint for an earlier turn, or another provider session, proves nothing.
    expect(
      resolveConversationBusy(
        session({ dispatchedRequestIds: ["resolve-1", "resolve-2"], activityTurn: settledTurn }),
        queue(),
      ),
    ).toBe(true);
    expect(
      resolveConversationBusy(
        session({ activityTurn: { ...settledTurn, providerSessionId: "provider-0" } }),
        queue(),
      ),
    ).toBe(true);
    expect(
      resolveConversationBusy(
        session({ activityTurn: { ...settledTurn, state: "active" } }),
        queue(),
      ),
    ).toBe(true);
  });

  test("waiting, claimed, in-flight and unconfirmed prompts are busy", () => {
    const idle = session({ activityTurn: settledTurn });
    expect(resolveConversationBusy(idle, queue({ messages: [{ id: "next" }] }))).toBe(true);
    expect(
      resolveConversationBusy(
        idle,
        queue({ inFlight: { message: {}, requestId: "next", reservedAt: "now" } }),
      ),
    ).toBe(true);
    expect(
      resolveConversationBusy(
        idle,
        queue({
          outstandingClaim: { token: "t", message: {}, claimedAt: "now", expiresAt: "later" },
        }),
      ),
    ).toBe(true);
    expect(
      resolveConversationBusy(
        { ...idle, pendingDispatch: { requestId: "next" } } as PersistedNativeAgentSession,
        queue(),
      ),
    ).toBe(true);
    expect(
      resolveConversationBusy(
        idle,
        queue({ jobReceipts: [{ requestId: "next", fingerprint: "f", status: "unknown" }] }),
      ),
    ).toBe(true);
    // An unknown receipt the session has already dispatched is not pending.
    expect(
      resolveConversationBusy(
        idle,
        queue({ jobReceipts: [{ requestId: "resolve-1", fingerprint: "f", status: "unknown" }] }),
      ),
    ).toBe(false);
  });
});

describe("resolveTabsSettled", () => {
  function storage(sessions: Record<string, PersistedNativeAgentSession>, resolveTab = true) {
    const tab = (id: string, jobCompletionAction?: string) => ({
      id,
      type: "agent-native",
      nativeAgentData: { platform: "claude" },
      ...(jobCompletionAction ? { jobCompletionAction } : {}),
    });
    return {
      getPaneLayout: async () =>
        ({
          root: {
            kind: "leaf",
            tabs: [
              tab(OTHER_TAB),
              ...(resolveTab ? [tab(RESOLVE_TAB, "refresh-pr-after-agent-completion")] : []),
            ],
          },
        }) as never,
      getNativeAgentSession: async (key: string) => sessions[key] ?? null,
      getPromptQueue: async () => null,
    };
  }
  const key = (tabId: string) => nativeAgentSessionStorageKey(ENV, "claude", logicalKey(tabId));

  test("only Resolve tabs decide; another busy tab does not hold Resolve open", async () => {
    expect(
      await resolveTabsSettled(
        storage({
          [key(RESOLVE_TAB)]: session({ activityTurn: settledTurn }),
          [key(OTHER_TAB)]: session({ dispatchedRequestIds: ["other-1"] }),
        }),
        ENV,
      ),
    ).toBe(true);
    expect(await resolveTabsSettled(storage({ [key(RESOLVE_TAB)]: session() }), ENV)).toBe(false);
  });

  test("no open Resolve tab means nothing is resolving", async () => {
    expect(await resolveTabsSettled(storage({}, false), ENV)).toBe(true);
  });
});
