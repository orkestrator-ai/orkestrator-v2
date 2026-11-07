/**
 * Plan item 3010: sessions, terminal sessions, Claude tmux and agent mail keep
 * one instance per node scope.
 *
 * For each store: two scopes keep independent state, the hook reads the
 * rendered scope's instance, and the hook carries no command-scope statics. Then each store's own work (commands, the prompt drafts the
 * tmux store owns, the mailbox batch) runs on its scope's node.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { StoreApi } from "zustand/vanilla";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { ScopedStoreDef } from "@/lib/node-scope/scoped-store";
import type { ScopedStoreHook } from "@/lib/node-scope/scoped-store";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { STORE_RESOURCE_HANDLERS, startStoreResourceSync } from "@/lib/store-resource-sync";
import {
  cleanupNodeScopes,
  FakeNodeClient,
  renderInNodeScope,
  type FakeNodeClientOptions,
} from "@/test/render-in-node-scope";
import type { Environment, Session } from "@/types";
import { agentMailStore, requestAgentMailMailbox, useAgentMailStore } from "./agentMailStore";
import { claudeTmuxStore, useClaudeTmuxStore } from "./claudeTmuxStore";
import { configStore } from "./configStore";
import { environmentStore } from "./environmentStore";
import { promptDraftStore, tmuxQuestionDraftKey } from "./promptDraftStore";
import { sessionStore, useSessionStore } from "./sessionStore";
import { terminalSessionStore, useTerminalSessionStore } from "./terminalSessionStore";
import * as barrel from "./index";

const NODE_A = "bk_session-store-a" as BackendId;
const NODE_B = "bk_session-store-b" as BackendId;

interface Case<S> {
  def: ScopedStoreDef<S>;
  hook: ScopedStoreHook<S>;
  write(store: StoreApi<S>): void;
  read(state: S): string;
}

function scopedCase<S>(entry: Case<S>): Case<unknown> {
  return entry as unknown as Case<unknown>;
}

function session(environmentId: string, name: string): Session {
  return {
    id: "session-1",
    environmentId,
    containerId: "container-1",
    tabId: "default",
    sessionType: "plain",
    status: "connected",
    createdAt: "2026-11-07T00:00:00.000Z",
    lastActivityAt: "2026-11-07T00:00:00.000Z",
    order: 0,
    name,
  } as Session;
}

const CASES: ReadonlyArray<Case<unknown>> = [
  scopedCase({
    def: sessionStore,
    hook: useSessionStore,
    write: (store) => store.getState().addSession(session("env-1", "written")),
    read: (state) => state.getSession("session-1")?.name ?? "none",
  }),
  scopedCase({
    def: terminalSessionStore,
    hook: useTerminalSessionStore,
    write: (store) => store.getState().setSession("local-env-1:default", { sessionId: "pty-1" }),
    read: (state) => state.getSessionId("local-env-1:default") ?? "none",
  }),
  scopedCase({
    def: claudeTmuxStore,
    hook: useClaudeTmuxStore,
    write: (store) => store.getState().setDraftText("env:env-1:tab:tab-1", "draft"),
    read: (state) => state.getDraftText("env:env-1:tab:tab-1") || "none",
  }),
  scopedCase({
    def: agentMailStore,
    hook: useAgentMailStore,
    write: (store) => store.getState().openPanel({ focus: "env-1\0tab-1" }),
    read: (state) => state.panel?.focus ?? "none",
  }),
];

let windowScope: WindowScope | null = null;

afterEach(() => {
  cleanupNodeScopes();
  windowScope?.dispose();
  windowScope = null;
  resetWindowScopeForTests();
});

function twoScopes(
  invokeA: FakeNodeClientOptions["invoke"] = {},
  invokeB: FakeNodeClientOptions["invoke"] = {},
) {
  windowScope = new WindowScope();
  const clientA = new FakeNodeClient({ nodeId: NODE_A, invoke: invokeA });
  const clientB = new FakeNodeClient({ nodeId: NODE_B, invoke: invokeB });
  const a = windowScope.open({ role: "command", client: clientA });
  const b = windowScope.open({ role: "leaf", client: clientB });
  return { a, b, clientA, clientB };
}

describe.each(CASES.map((entry) => [entry.def.name, entry] as const))("%s", (_name, entry) => {
  test("each node scope holds its own instance", () => {
    const { a, b } = twoScopes();
    const storeA = a.store(entry.def);
    const storeB = b.store(entry.def);
    expect(storeA).not.toBe(storeB);
    const before = entry.read(storeB.getState());

    entry.write(storeA);

    expect(entry.read(storeA.getState())).not.toBe(before);
    expect(entry.read(storeB.getState())).toBe(before);
    b.dispose();
    expect(() => b.store(entry.def)).toThrow();
    expect(a.store(entry.def)).toBe(storeA);
  });

  test("the hook reads the rendered scope's instance", () => {
    const Reader = () => <span data-testid="value">{entry.read(entry.hook())}</span>;
    const { scope } = renderInNodeScope(<Reader />, { nodeId: NODE_A });
    const initial = screen.getByTestId("value").textContent;

    act(() => entry.write(scope.store(entry.def)));

    expect(screen.getByTestId("value").textContent).not.toBe(initial);
    expect(entry.read(getWindowScope().commandScope().store(entry.def).getState())).toBe(initial);
  });

  test("the hook has no command-scope statics", () => {
    // Plan item 3018: a static would pick a node without being told which.
    for (const name of ["getState", "setState", "subscribe", "getInitialState"])
      expect([name, name in entry.hook]).toEqual([name, false]);
    expect(entry.hook.def).toBe(entry.def);
  });
});

test("the barrel exports each converted def beside its hook", () => {
  expect(barrel.sessionStore).toBe(sessionStore);
  expect(barrel.terminalSessionStore).toBe(terminalSessionStore);
  expect(barrel.claudeTmuxStore).toBe(claudeTmuxStore);
  expect(barrel.agentMailStore).toBe(agentMailStore);
  for (const entry of CASES) expect(entry.hook.def).toBe(entry.def);
});

test("sessions load from their own node", async () => {
  const { a, b, clientA, clientB } = twoScopes(
    { get_sessions_by_environment: [session("env-1", "on A")] },
    { get_sessions_by_environment: [session("env-1", "on B")] },
  );

  await b.store(sessionStore).getState().loadSessionsForEnvironment("env-1");

  expect(clientB.calls("get_sessions_by_environment")).toHaveLength(1);
  expect(clientA.invocations).toEqual([]);
  expect(b.store(sessionStore).getState().getSession("session-1")?.name).toBe("on B");
  expect(a.store(sessionStore).getState().getSession("session-1")).toBeUndefined();
  // The snapshot generation is the loading node's own.
  expect(b.store(sessionStore).getState().sessionSnapshotGenerations.get("env-1")).toBe(1);
  expect(a.store(sessionStore).getState().sessionSnapshotGenerations.size).toBe(0);
});

test("a resolved tmux prompt clears its draft on its own node", () => {
  const { a, b } = twoScopes();
  const key = "env:env-1:tab:tab-1";
  const draftKey = tmuxQuestionDraftKey(key, "event-1");
  for (const scope of [a, b]) {
    scope.store(claudeTmuxStore).getState().setRunning(key, true, { environmentId: "env-1" });
    scope.store(claudeTmuxStore).getState().addPendingQuestion(key, {
      eventId: "event-1",
      questions: [],
      toolInput: {},
      payload: {},
      receivedAt: "2026-11-07T00:00:00.000Z",
    });
    scope.store(promptDraftStore).getState().setDraftValue(draftKey, "answer", "yes");
  }

  b.store(claudeTmuxStore).getState().removePendingQuestion(key, "event-1");

  expect(b.store(promptDraftStore).getState().drafts.has(draftKey)).toBe(false);
  expect(a.store(promptDraftStore).getState().drafts.has(draftKey)).toBe(true);
  expect(a.store(claudeTmuxStore).getState().getTab(key).pendingQuestions).toHaveLength(1);
});

test("agent mail reads, batches and clears per node", async () => {
  const summary = { revision: 3, mailboxes: [] };
  const { a, b, clientA, clientB } = twoScopes(
    { get_agent_mail_summary: summary, get_agent_mail_mailboxes: { mailboxes: [] } },
    { get_agent_mail_summary: summary, get_agent_mail_mailboxes: { mailboxes: [] } },
  );

  await b.store(agentMailStore).getState().refreshSummary();
  expect(clientB.calls("get_agent_mail_summary")).toHaveLength(1);
  expect(clientA.invocations).toEqual([]);
  expect(b.store(agentMailStore).getState().revision).toBe(3);
  expect(a.store(agentMailStore).getState().revision).toBe(0);

  // Requests made in one tick go out as one batch, to the asking node only.
  requestAgentMailMailbox("env-1", "tab-1", b);
  requestAgentMailMailbox("env-1", "tab-2", b);
  requestAgentMailMailbox("env-1", "tab-1", a);
  await waitFor(() => expect(clientB.calls("get_agent_mail_mailboxes")).toHaveLength(1));
  expect(clientB.calls("get_agent_mail_mailboxes")[0]?.args).toEqual({
    addresses: [
      { environmentId: "env-1", tabId: "tab-1" },
      { environmentId: "env-1", tabId: "tab-2" },
    ],
  });
  await waitFor(() => expect(clientA.calls("get_agent_mail_mailboxes")).toHaveLength(1));

  // Each node remembers what it asked for: a repeat on B is not sent again,
  // and clearing A forgets only A's.
  a.store(agentMailStore).getState().clear();
  requestAgentMailMailbox("env-1", "tab-1", b);
  requestAgentMailMailbox("env-1", "tab-1", a);
  await waitFor(() => expect(clientA.calls("get_agent_mail_mailboxes")).toHaveLength(2));
  expect(clientB.calls("get_agent_mail_mailboxes")).toHaveLength(1);
});

test("a leaf scope's own sync keeps that node's sessions and agent mail", async () => {
  const summary = { revision: 5, mailboxes: [] };
  const { a, b, clientA, clientB } = twoScopes(
    {},
    {
      get_sessions_by_environment: [session("env-1", "on B")],
      get_agent_mail_summary: summary,
      get_agent_mail_mailboxes: { mailboxes: [] },
    },
  );
  b.store(environmentStore)
    .getState()
    .setEnvironments([{ id: "env-1", projectId: "p-1" } as Environment]);
  b.store(configStore).setState((state) => ({
    config: {
      ...state.config,
      global: { ...state.config.global, agentMessaging: { enabled: true } },
    } as typeof state.config,
  }));
  const handlers = STORE_RESOURCE_HANDLERS.filter(({ name }) =>
    ["sessions", "agent-mail"].includes(name),
  );
  expect(handlers.map(({ runsOn }) => runsOn)).toEqual(["every-scope", "every-scope"]);
  const stop = startStoreResourceSync({}, { scope: b, handlers });
  try {
    dispatchResourceChange({ resource: "session", id: "env-1", revision: 1 }, b);
    dispatchResourceChange({ resource: "agent-mail-summary", id: "all", revision: 1 }, b);

    await waitFor(() =>
      expect(b.store(sessionStore).getState().getSession("session-1")?.name).toBe("on B"),
    );
    await waitFor(() => expect(b.store(agentMailStore).getState().revision).toBe(5));
    expect(clientA.invocations).toEqual([]);
    expect(clientB.calls("get_sessions_by_environment")).toHaveLength(1);
    expect(a.store(sessionStore).getState().sessions.size).toBe(0);
    expect(a.store(agentMailStore).getState().revision).toBe(0);
  } finally {
    stop();
  }
});
