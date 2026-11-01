import { describe, expect, test } from "bun:test";
import { parseClientStateCapabilities } from "./client-state.js";
import {
  parseCoordinatorPaneLayoutRecord,
  parseCoordinatorPaneLayoutSaveResult,
  type CoordinatorPaneLayout,
} from "./coordinator-pane-layout.js";
import { isEnvironmentAttentionEvent } from "./environment-attention.js";
import {
  NOTICE_DISMISSAL_LIMITS,
  normalizeNoticeDismissalSessions,
  parseNoticeDismissalSnapshot,
} from "./notice-dismissals.js";

const layout: CoordinatorPaneLayout = {
  root: { kind: "leaf", id: "pane", conversationIds: ["a"], activeConversationId: "a" },
  activePaneId: "pane",
};

describe("client state capabilities", () => {
  test("anything but an explicit true is unsupported", () => {
    expect(parseClientStateCapabilities(undefined)).toEqual({
      coordinatorPaneLayouts: false,
      coordinatorUpstreamMerge: false,
      noticeDismissals: false,
      environmentAttention: false,
    });
    expect(
      parseClientStateCapabilities({ coordinatorPaneLayouts: true, noticeDismissals: "yes" }),
    ).toMatchObject({ coordinatorPaneLayouts: true, noticeDismissals: false });
  });
});

describe("coordinator pane layout records", () => {
  test("parse a stored record and reject malformed ones", () => {
    const record = { projectId: "p", layout, revision: 3, updatedAt: "2026-11-01T00:00:00.000Z" };
    expect(parseCoordinatorPaneLayoutRecord(record)).toEqual(record);
    expect(parseCoordinatorPaneLayoutRecord({ ...record, revision: 0 })).toBeNull();
    expect(parseCoordinatorPaneLayoutRecord({ ...record, layout: { root: null } })).toBeNull();
    expect(parseCoordinatorPaneLayoutSaveResult({ status: "saved", record })).toEqual({
      status: "saved",
      record,
    });
    expect(parseCoordinatorPaneLayoutSaveResult({ status: "conflict", current: null })).toEqual({
      status: "conflict",
      current: null,
    });
    expect(parseCoordinatorPaneLayoutSaveResult(undefined)).toBeNull();
  });
});

describe("notice dismissals", () => {
  test("normalization drops invalid entries, de-duplicates and bounds each session", () => {
    const many = Array.from(
      { length: NOTICE_DISMISSAL_LIMITS.occurrencesPerSession + 3 },
      (_, i) => `n${i}`,
    );
    const sessions = normalizeNoticeDismissalSessions([
      { sessionIdentity: "s", occurrenceIds: ["x", "x", 3] },
      { sessionIdentity: "", occurrenceIds: ["y"] },
      { sessionIdentity: "t", occurrenceIds: many },
      { sessionIdentity: "s", occurrenceIds: ["z"] },
      null,
    ]);
    expect(sessions).toEqual([
      {
        sessionIdentity: "t",
        occurrenceIds: many.slice(-NOTICE_DISMISSAL_LIMITS.occurrencesPerSession),
      },
      { sessionIdentity: "s", occurrenceIds: ["z"] },
    ]);
    expect(parseNoticeDismissalSnapshot({ revision: 2, sessions })?.revision).toBe(2);
    expect(parseNoticeDismissalSnapshot({ revision: -1, sessions })).toBeNull();
  });
});

describe("environment attention events", () => {
  test("validate the content-free shape", () => {
    const event = {
      attentionId: "a",
      environmentId: "e",
      projectId: "p",
      reason: "agent_finished",
      occurredAt: "2026-11-01T00:00:00.000Z",
    };
    expect(isEnvironmentAttentionEvent(event)).toBe(true);
    expect(isEnvironmentAttentionEvent({ ...event, reason: "marked_unread" })).toBe(false);
    expect(isEnvironmentAttentionEvent({ ...event, attentionId: "" })).toBe(false);
  });
});
