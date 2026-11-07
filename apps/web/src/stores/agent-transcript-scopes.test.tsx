/**
 * Plan item 3009: the agent and transcript stores per node, with retained
 * history bounded window-wide.
 *
 * Every test opens its own window with two nodes (`A` the command scope, `B`
 * a leaf) and names each node's instance, as converted code does.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import type { BackendId } from "@orkestrator/protocol/federation";
import { resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { forgetAgentHandoff, loadAgentHandoff } from "@/lib/agent-handoff";
import { loadComposeDraft, persistComposeDraft } from "@/lib/compose-draft-persistence";
import {
  nativeSessionViewCount,
  registerNativeSessionView,
  runNativeSessionReadRound,
} from "@/lib/native-session-shared-reads";
import { FakeNodeClient, type FakeNodeClientOptions } from "@/test/render-in-node-scope";
import {
  evictNativeAgentHistoryCaches,
  nativeAgentHistoryBytesExcept,
  nativeAgentProjectionStore,
  recomputeNativeAgentProjectionTotals,
  type NativeAgentSyncCacheEntry,
} from "./nativeAgentProjectionStore";
import { nativeComposeDraft, nativeComposeStore } from "./nativeComposeStore";
import { promptDraftStore } from "./promptDraftStore";
import * as barrel from "./index";

const NODE_A = "bk_transcripts-a" as BackendId;
const NODE_B = "bk_transcripts-b" as BackendId;
/** The window's shared history bound in these tests. */
const BUDGET = 100;

let windowScope: WindowScope;
let clientA: FakeNodeClient;
let clientB: FakeNodeClient;
let scopeA: NodeScope;
let scopeB: NodeScope;

function openWindow(
  invoke: {
    a?: FakeNodeClientOptions["invoke"];
    b?: FakeNodeClientOptions["invoke"];
  } = {},
) {
  windowScope.dispose();
  windowScope = new WindowScope({ budgets: { transcripts: BUDGET } });
  clientA = new FakeNodeClient({ nodeId: NODE_A, invoke: invoke.a });
  clientB = new FakeNodeClient({ nodeId: NODE_B, invoke: invoke.b });
  scopeA = windowScope.open({ role: "command", client: clientA });
  scopeB = windowScope.open({ role: "leaf", client: clientB });
}

beforeEach(() => {
  windowScope = new WindowScope();
  openWindow();
});

afterEach(() => {
  windowScope.dispose();
  resetWindowScopeForTests();
});

function projection(
  id: string,
  messages: unknown[],
  turn: NativeAgentSessionProjection["turn"] = { phase: "idle" },
): NativeAgentSessionProjection {
  return {
    platform: "codex",
    environmentId: "env-1",
    sessionId: id,
    connection: "connected",
    turn,
    messages,
    interactions: [],
    composerControls: [],
    capabilities: {
      attachments: { files: false, images: false },
      queue: false,
      resume: false,
      fork: false,
      slashCommands: false,
      backgroundTasks: false,
      composer: { provider: false, model: false, reasoning: false, speed: false, mode: false },
    },
    revision: 1,
    generation: "generation-1",
  };
}

/** A session shown with `historyBytes` of retained pages above its live tail. */
function show(scope: NodeScope, sessionKey: string, historyBytes: number): void {
  const live = projection(`${sessionKey}-live`, [{ id: `${sessionKey}-live` }]);
  const history = [{ id: `${sessionKey}-history` }];
  const cache: NativeAgentSyncCacheEntry = {
    liveProjection: live,
    historyComplete: false,
    historyMessages: history,
    historyBytes,
  };
  scope
    .store(nativeAgentProjectionStore)
    .getState()
    .setProjection(
      sessionKey,
      projection(`${sessionKey}-materialized`, [...history, ...live.messages]),
      cache,
    );
}

function retained(scope: NodeScope): string[] {
  return [...scope.store(nativeAgentProjectionStore).getState().syncCaches.keys()];
}

function evictions(scope: NodeScope, sessionKey: string): number {
  return scope.store(nativeAgentProjectionStore).getState().historyEvictions.get(sessionKey) ?? 0;
}

/** Each node's reservations equal what its store retains. */
function expectReservationsMatchStores(): void {
  for (const scope of [scopeA, scopeB]) {
    const state = scope.store(nativeAgentProjectionStore).getState();
    expect(windowScope.budgets.transcripts.usedBytesFor(scope.nodeId)).toBe(
      recomputeNativeAgentProjectionTotals(state).historyBytesTotal,
    );
  }
  expect(windowScope.budgets.transcripts.usedBytes).toBeLessThanOrEqual(BUDGET);
}

describe("per-node agent and transcript stores", () => {
  test("each node keeps its own projections, compose drafts and prompt drafts", () => {
    const key = "env-1:tab-1";
    show(scopeA, key, 10);
    scopeA.store(nativeComposeStore).getState().updateDraft(key, { text: "for A" });
    scopeB.store(nativeComposeStore).getState().updateDraft(key, { text: "for B" });
    scopeA.store(promptDraftStore).getState().setDraftValue("draft", "answer", "a");

    expect(scopeA.store(nativeAgentProjectionStore).getState().projections.has(key)).toBe(true);
    expect(scopeB.store(nativeAgentProjectionStore).getState().projections.has(key)).toBe(false);
    expect(nativeComposeDraft(scopeA.store(nativeComposeStore).getState(), key).text).toBe("for A");
    expect(nativeComposeDraft(scopeB.store(nativeComposeStore).getState(), key).text).toBe("for B");
    expect(scopeB.store(promptDraftStore).getState().drafts.size).toBe(0);
  });

  test("the barrel exports each def beside its hook", () => {
    expect(barrel.nativeAgentProjectionStore).toBe(nativeAgentProjectionStore);
    expect(barrel.nativeComposeStore).toBe(nativeComposeStore);
    expect(barrel.promptDraftStore).toBe(promptDraftStore);
    expect(barrel.useNativeAgentProjectionStore.def).toBe(nativeAgentProjectionStore);
  });
});

describe("retained history shares one window budget", () => {
  test("filling it on B evicts the least recently shown history, never the shown session", () => {
    show(scopeA, "a1", 30);
    show(scopeA, "a2", 30);
    show(scopeB, "b1", 30);
    // Shown again: a1 is now more recent than a2.
    scopeA
      .store(nativeAgentProjectionStore)
      .getState()
      .setProjection(
        "a1",
        scopeA.store(nativeAgentProjectionStore).getState().projections.get("a1")!,
      );

    // No shown node yet: another node's least recently shown history goes first.
    show(scopeB, "b2", 30);
    expect(retained(scopeA)).toEqual(["a1"]);
    expect(evictions(scopeA, "a2")).toBe(1);
    // Evicted history keeps its bounded live projection on screen.
    expect(
      scopeA.store(nativeAgentProjectionStore).getState().projections.get("a2")?.sessionId,
    ).toBe("a2-live");
    expect(retained(scopeB)).toEqual(["b1", "b2"]);
    expectReservationsMatchStores();

    // A is shown: its history is never evicted, so B makes room from its own.
    windowScope.budgets.transcripts.setShownNode(NODE_A);
    show(scopeB, "b3", 30);
    expect(retained(scopeA)).toEqual(["a1"]);
    expect(retained(scopeB)).toEqual(["b2", "b3"]);
    expect(evictions(scopeB, "b1")).toBe(1);
    expectReservationsMatchStores();

    // More than B can free beside the shown node: refused, so B keeps only the
    // live tail of that session, and nothing of A's is touched.
    show(scopeB, "b4", 80);
    expect(retained(scopeA)).toEqual(["a1"]);
    expect(retained(scopeB)).not.toContain("b4");
    expect(evictions(scopeB, "b4")).toBe(1);
    expectReservationsMatchStores();

    // B shown: the session B is writing is never a victim either.
    windowScope.budgets.transcripts.setShownNode(NODE_B);
    show(scopeB, "b2", 50);
    expect(retained(scopeA)).toEqual([]);
    expect(evictions(scopeA, "a1")).toBe(1);
    expect(retained(scopeB)).toEqual(["b2", "b3"]);
    expectReservationsMatchStores();
  });

  test("the reader's room and its eviction pass are window-wide", () => {
    show(scopeA, "a1", 40);
    show(scopeB, "b1", 20);
    // B's tab sizes its next page against everything else the window retains.
    expect(nativeAgentHistoryBytesExcept("b1", scopeB)).toBe(40);
    expect(nativeAgentHistoryBytesExcept("a1", scopeA)).toBe(20);

    // B frees room for a 60-byte page: A's history (not shown) goes, B's stays.
    evictNativeAgentHistoryCaches("b1", 60, BUDGET, scopeB);
    expect(retained(scopeA)).toEqual([]);
    expect(retained(scopeB)).toEqual(["b1"]);
    expect(nativeAgentHistoryBytesExcept("b1", scopeB)).toBe(0);
    expectReservationsMatchStores();
  });

  test("disposing a node releases its history and keeps the other's", () => {
    show(scopeA, "a1", 30);
    show(scopeB, "b1", 30);
    scopeB.dispose();
    expect(windowScope.budgets.transcripts.usedBytesFor(NODE_B)).toBe(0);
    expect(windowScope.budgets.transcripts.usedBytes).toBe(30);
    expect(retained(scopeA)).toEqual(["a1"]);
  });
});

describe("node-owned companions", () => {
  test("draft persistence is per node: each node's commands and revision cursor", async () => {
    let revisionA = 4;
    let revisionB = 0;
    const saved = (draftKey: unknown, revision: number) => ({
      draftKey,
      ownerType: "environment",
      ownerId: "env-1",
      value: {},
      revision,
      updatedAt: "2026-11-07T00:00:00.000Z",
    });
    openWindow({
      a: {
        get_compose_draft: (args: Readonly<Record<string, unknown>>) =>
          saved(args.draftKey, revisionA),
        save_compose_draft: (args: Readonly<Record<string, unknown>>) =>
          saved(args.draftKey, ++revisionA),
      },
      b: {
        get_compose_draft: null,
        save_compose_draft: (args: Readonly<Record<string, unknown>>) =>
          saved(args.draftKey, ++revisionB),
      },
    });
    const key = "agent-native:env-1:tab-1";

    expect((await loadComposeDraft(key, undefined, scopeA))?.revision).toBe(4);
    expect(await loadComposeDraft(key, undefined, scopeB)).toBeNull();
    await persistComposeDraft(key, "environment", "env-1", { text: "A" }, undefined, scopeA);
    await persistComposeDraft(key, "environment", "env-1", { text: "B" }, undefined, scopeB);
    await persistComposeDraft(key, "environment", "env-1", { text: "A2" }, undefined, scopeA);

    // Each node saw only its own drafts, swapped against its own revisions.
    expect(clientA.calls("save_compose_draft").map((call) => call.args.expectedRevision)).toEqual([
      4, 5,
    ]);
    expect(clientB.calls("save_compose_draft").map((call) => call.args.expectedRevision)).toEqual([
      0,
    ]);
    expect(clientB.calls("save_compose_draft")[0]?.args.value).toEqual({ text: "B" });
  });

  test("handoff snapshots and shared session reads are per node", async () => {
    openWindow({ a: { get_agent_handoff: null }, b: { get_agent_handoff: null } });
    await loadAgentHandoff("handoff-1", scopeA);
    await loadAgentHandoff("handoff-1", scopeB);
    // Cached per node: a second read on A asks nobody.
    await loadAgentHandoff("handoff-1", scopeA);
    expect(clientA.calls("get_agent_handoff")).toHaveLength(1);
    expect(clientB.calls("get_agent_handoff")).toHaveLength(1);
    forgetAgentHandoff("handoff-1", scopeB);
    await loadAgentHandoff("handoff-1", scopeA);
    expect(clientA.calls("get_agent_handoff")).toHaveLength(1);

    let refreshes = 0;
    const stop = registerNativeSessionView(
      "target",
      { wantsBackgroundRead: () => true, refresh: async () => (refreshes += 1) },
      scopeA,
    );
    await runNativeSessionReadRound("target", { reason: "interval" } as never, scopeB);
    expect(refreshes).toBe(0);
    expect(nativeSessionViewCount("target", scopeB)).toBe(0);
    await runNativeSessionReadRound("target", { reason: "interval" } as never, scopeA);
    expect(refreshes).toBe(1);
    stop();
    expect(nativeSessionViewCount("target", scopeA)).toBe(0);
  });
});

/*
 * AGENTS.md "Test the inactive-environment path", at the store level: work
 * starts on B, the user switches to A (whose history then fills the budget),
 * B's backend finishes the turn, and the user returns to B.
 */
test("inactive node: switching away keeps B's status, messages, pending prompts and drafts", () => {
  const key = "env-1:tab-1";
  const b = scopeB.store(nativeAgentProjectionStore);
  // Work starts on B: a running turn, a pending question, an answer in
  // progress and a held prompt in the composer.
  const pending = { interactions: [{ id: "question-1" }] as never };
  const running = { ...projection("b-session", [{ id: "m1" }], { phase: "running" }), ...pending };
  b.getState().setProjection(
    key,
    {
      ...projection("b-session", [{ id: "h1" }, { id: "m1" }], { phase: "running" }),
      ...pending,
    },
    {
      liveProjection: running,
      historyComplete: false,
      historyMessages: [{ id: "h1" }],
      historyBytes: 40,
    },
  );
  scopeB.store(promptDraftStore).getState().setDraftValue("question-1", "answers", { q: "yes" });
  scopeB
    .store(nativeComposeStore)
    .getState()
    .updateDraft(key, { text: "next step", requestId: "request-1", submissionPending: true });

  // Switch to A: A is shown and its tab retains a lot of history.
  windowScope.budgets.transcripts.setShownNode(NODE_A);
  show(scopeA, "a1", 90);

  // B's retained history made room, but nothing B's tab needs on return went.
  expect(retained(scopeB)).toEqual([]);
  expect(evictions(scopeB, key)).toBe(1);
  const away = b.getState().projections.get(key);
  expect(away?.turn.phase).toBe("running");
  expect(away?.messages).toEqual([{ id: "m1" }]);
  expect(away?.interactions).toEqual([{ id: "question-1" }] as never);
  expect(scopeB.store(promptDraftStore).getState().drafts.get("question-1")).toEqual({
    answers: { q: "yes" },
  });
  expect(nativeComposeDraft(scopeB.store(nativeComposeStore).getState(), key)).toMatchObject({
    text: "next step",
    requestId: "request-1",
    submissionPending: true,
  });

  // B's backend finishes the turn while A is shown; returning reads its
  // authoritative snapshot, which replaces the cached tail.
  windowScope.budgets.transcripts.setShownNode(NODE_B);
  const finished = projection("b-session", [{ id: "m1" }, { id: "m2" }]);
  b.getState().setProjection(key, { ...finished, revision: 2 }, { ...emptyCache(finished) });
  const back = b.getState().projections.get(key);
  expect(back?.turn.phase).toBe("idle");
  expect(back?.messages).toEqual([{ id: "m1" }, { id: "m2" }]);
  expect(scopeA.store(nativeAgentProjectionStore).getState().syncCaches.has("a1")).toBe(true);
  expectReservationsMatchStores();
});

function emptyCache(live: NativeAgentSessionProjection): NativeAgentSyncCacheEntry {
  return { liveProjection: live, historyComplete: true, historyMessages: [], historyBytes: 0 };
}
