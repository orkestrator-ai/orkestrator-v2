import { describe, expect, test } from "bun:test";
import type { PersistedNativeAgentSession, PersistedPromptQueue } from "./models.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { resolveConversationBusy, resolveTabsSettled } from "./pr-auto-merge-resolve-settled.js";
import { nativePromptQueueKey } from "./public-api/index.js";

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
  const tab = (id: string, jobCompletionAction?: string, platform = "claude") => ({
    id,
    type: "agent-native",
    nativeAgentData: { platform },
    ...(jobCompletionAction ? { jobCompletionAction } : {}),
  });
  const resolveTab = (id: string, platform = "claude") =>
    tab(id, "refresh-pr-after-agent-completion", platform);
  function storage(
    sessions: Record<string, PersistedNativeAgentSession>,
    options: {
      root?: unknown;
      queues?: Record<string, PersistedPromptQueue>;
    } = {},
  ) {
    return {
      getPaneLayout: async () =>
        ({
          root: options.root ?? { kind: "leaf", tabs: [tab(OTHER_TAB), resolveTab(RESOLVE_TAB)] },
        }) as never,
      getNativeAgentSession: async (key: string) => sessions[key] ?? null,
      getPromptQueue: async (key: string) => options.queues?.[key] ?? null,
    };
  }
  const key = (tabId: string, agent: "claude" | "codex" = "claude") =>
    nativeAgentSessionStorageKey(ENV, agent, logicalKey(tabId));
  const queueKey = (tabId: string, agent: "claude" | "codex" = "claude") =>
    nativePromptQueueKey(agent, logicalKey(tabId));

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
    expect(
      await resolveTabsSettled(
        storage({}, { root: { kind: "leaf", tabs: [tab(OTHER_TAB)] } }),
        ENV,
      ),
    ).toBe(true);
  });

  test("a prompt queued on the Resolve tab holds it open; one on another tab does not", async () => {
    const sessions = { [key(RESOLVE_TAB)]: session({ activityTurn: settledTurn }) };
    expect(
      await resolveTabsSettled(
        storage(sessions, {
          queues: { [queueKey(RESOLVE_TAB)]: queue({ messages: [{ id: "next" }] }) },
        }),
        ENV,
      ),
    ).toBe(false);
    expect(
      await resolveTabsSettled(
        storage(sessions, {
          queues: { [queueKey(OTHER_TAB)]: queue({ messages: [{ id: "elsewhere" }] }) },
        }),
        ENV,
      ),
    ).toBe(true);
    // Keyed by the tab's own agent: a Claude queue says nothing about a Codex Resolve tab.
    expect(
      await resolveTabsSettled(
        storage(
          { [key(RESOLVE_TAB, "codex")]: session({ activityTurn: settledTurn }) },
          {
            root: { kind: "leaf", tabs: [resolveTab(RESOLVE_TAB, "codex")] },
            queues: { [queueKey(RESOLVE_TAB)]: queue({ messages: [{ id: "next" }] }) },
          },
        ),
        ENV,
      ),
    ).toBe(true);
    expect(
      await resolveTabsSettled(
        storage(
          { [key(RESOLVE_TAB, "codex")]: session({ activityTurn: settledTurn }) },
          {
            root: { kind: "leaf", tabs: [resolveTab(RESOLVE_TAB, "codex")] },
            queues: { [queueKey(RESOLVE_TAB, "codex")]: queue({ messages: [{ id: "next" }] }) },
          },
        ),
        ENV,
      ),
    ).toBe(false);
  });

  test("every Resolve tab across a split layout must settle", async () => {
    const SECOND = "agent-job-resolve-2";
    const root = {
      kind: "split",
      children: [
        { kind: "leaf", tabs: [tab(OTHER_TAB), resolveTab(RESOLVE_TAB)] },
        { kind: "split", children: [{ kind: "leaf", tabs: [resolveTab(SECOND)] }] },
      ],
    };
    const settledSession = session({ activityTurn: settledTurn });
    expect(
      await resolveTabsSettled(
        storage({ [key(RESOLVE_TAB)]: settledSession, [key(SECOND)]: settledSession }, { root }),
        ENV,
      ),
    ).toBe(true);
    // The nested tab is still working, so the first one settling is not enough.
    expect(
      await resolveTabsSettled(
        storage({ [key(RESOLVE_TAB)]: settledSession, [key(SECOND)]: session() }, { root }),
        ENV,
      ),
    ).toBe(false);
    expect(
      await resolveTabsSettled(
        storage(
          { [key(RESOLVE_TAB)]: settledSession, [key(SECOND)]: settledSession },
          {
            root,
            queues: {
              [queueKey(SECOND)]: queue({
                inFlight: { message: {}, requestId: "next", reservedAt: "now" },
              }),
            },
          },
        ),
        ENV,
      ),
    ).toBe(false);
  });
});
