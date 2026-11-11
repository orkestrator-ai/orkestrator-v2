import { describe, expect, test } from "bun:test";
import { COORDINATOR_ASYNC_CONTRACT } from "@orkestrator/protocol/coordinator";
import {
  agentRegistryFingerprint,
  COORDINATOR_POLL_BUDGET,
  COORDINATOR_POLL_WINDOW_MS,
  CoordinatorPollTracker,
  pollKey,
  tabStateFingerprint,
  transcriptFingerprint,
  workflowFingerprint,
  workflowListFingerprint,
} from "./poll-guard.js";

const scope = { coordinatorId: "coordinator-1", conversationId: "conversation-1" };

function tracker(options: { maxEntries?: number } = {}) {
  let now = 0;
  const polls = new CoordinatorPollTracker({ ...options, now: () => now });
  return {
    polls,
    guard: polls.guard(scope),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("CoordinatorPollTracker", () => {
  test("the read after the budget is flagged, with the async contract", () => {
    const { guard } = tracker();
    for (let read = 0; read < COORDINATOR_POLL_BUDGET; read += 1) {
      expect(guard("list_agents", "same")).toBeNull();
    }
    expect(guard("list_agents", "same")).toEqual({
      repeatedRead: true,
      instruction: COORDINATOR_ASYNC_CONTRACT,
    });
  });

  test("the window slides, so slow polling is caught", () => {
    const { guard, advance } = tracker();
    // One read every 50 seconds never fit three repeats into a fixed window.
    for (let read = 0; read < COORDINATOR_POLL_BUDGET; read += 1) {
      expect(guard("get_tab_state", "same")).toBeNull();
      advance(50_000);
    }
    expect(guard("get_tab_state", "same")).toMatchObject({ repeatedRead: true });
  });

  test("a gap longer than the window starts the count again", () => {
    const { guard, advance } = tracker();
    for (let read = 0; read < COORDINATOR_POLL_BUDGET; read += 1) guard("read", "same");
    advance(COORDINATOR_POLL_WINDOW_MS + 1);
    expect(guard("read", "same")).toBeNull();
  });

  test("a changed answer is never flagged, and questions count separately", () => {
    const { guard } = tracker();
    for (let read = 0; read < COORDINATOR_POLL_BUDGET; read += 1) guard("read", "same");
    expect(guard("read", "changed")).toBeNull();
    expect(guard("other", "same")).toBeNull();
  });

  test("entries are bounded, and a revoked conversation starts over", () => {
    const { polls, guard } = tracker({ maxEntries: 2 });
    guard("a", "x");
    guard("b", "x");
    guard("c", "x");
    expect(polls.size).toBe(2);
    polls.forget(scope.coordinatorId, scope.conversationId);
    expect(polls.size).toBe(0);
  });
});

describe("poll fingerprints", () => {
  test("a key names the question, never the page size", () => {
    expect(pollKey("read_messages", "env", "tab", false)).toBe(
      pollKey("read_messages", "env", "tab", false),
    );
    expect(pollKey("read_messages", "env", "tab", true)).not.toBe(
      pollKey("read_messages", "env", "tab", false),
    );
    expect(pollKey("list_agents", undefined, "env")).toBe(pollKey("list_agents", null, "env"));
  });

  test("a transcript is the same answer whatever limit asked for, until a new row", () => {
    const rows = (ids: string[]) => ({
      connection: "connected",
      messages: ids.map((id) => ({ id, parts: [] })),
    });
    expect(transcriptFingerprint(rows(["m2", "m3"]))).toBe(
      transcriptFingerprint(rows(["m1", "m2", "m3"])),
    );
    expect(transcriptFingerprint(rows(["m1", "m2", "m3", "m4"]))).not.toBe(
      transcriptFingerprint(rows(["m1", "m2", "m3"])),
    );
  });

  test("a tab's streaming revision is not news; a new question or phase is", () => {
    const state = (overrides: Record<string, unknown>) => ({
      agent: "codex",
      state: {
        connection: "connected",
        turn: { phase: "running" },
        interactions: [],
        revision: 1,
        ...overrides,
      },
    });
    expect(tabStateFingerprint(state({ revision: 9 }))).toBe(tabStateFingerprint(state({})));
    expect(tabStateFingerprint(state({ turn: { phase: "idle" } }))).not.toBe(
      tabStateFingerprint(state({})),
    );
    expect(tabStateFingerprint(state({ interactions: [{ id: "q-1" }] }))).not.toBe(
      tabStateFingerprint(state({})),
    );
  });

  test("agent tabs are compared on what each is doing", () => {
    const entries = (state: string) => ({
      entries: [{ environmentId: "env-1", tabId: "tab-1", state, displayName: "x" }],
      updatedAt: Math.random(),
    });
    expect(agentRegistryFingerprint(entries("working"))).toBe(
      agentRegistryFingerprint(entries("working")),
    );
    expect(agentRegistryFingerprint(entries("idle"))).not.toBe(
      agentRegistryFingerprint(entries("working")),
    );
  });

  test("a workflow's timestamps and revision are not news; its phase is", () => {
    const summary = (phase: string, revision: number) => ({
      id: "pipeline-1",
      phase,
      workers: [{ address: "build", status: "running", lastActivityAt: revision }],
      updatedAt: `2026-11-05T00:00:0${revision}Z`,
      revision,
    });
    expect(workflowFingerprint(summary("building", 2))).toBe(
      workflowFingerprint(summary("building", 1)),
    );
    expect(workflowFingerprint(summary("reviewing", 1))).not.toBe(
      workflowFingerprint(summary("building", 1)),
    );
    expect(
      workflowListFingerprint([
        { id: "a", delegation: { state: "running" }, resource: summary("building", 1) },
      ]),
    ).not.toBe(
      workflowListFingerprint([
        { id: "a", delegation: { state: "completed" }, resource: summary("building", 1) },
      ]),
    );
  });
});
