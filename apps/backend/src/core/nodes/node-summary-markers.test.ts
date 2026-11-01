import { expect, test } from "bun:test";
import type { AgentMailSummaryEntry } from "@orkestrator/protocol/agent-mail";
import { MAX_SUMMARY_MAIL_COUNT } from "@orkestrator/protocol/node-summaries";
import { environmentMailMarkers, isWorkingPipelineRecord } from "./node-summary-markers.js";

function mailbox(
  environmentId: string,
  extra: Partial<AgentMailSummaryEntry> = {},
): AgentMailSummaryEntry {
  return {
    mailboxId: `${environmentId}-${extra.tabId ?? "tab"}`,
    projectId: "p",
    environmentId,
    tabId: "tab",
    unreadCount: 0,
    userUnseenCount: 0,
    agentUnackedCount: 0,
    pendingInjectCount: 0,
    failedInjectCount: 0,
    revision: 1,
    ...extra,
  };
}

test("mail markers count each environment as its own sidebar row does", () => {
  const markers = environmentMailMarkers({
    revision: 1,
    mailboxes: [
      mailbox("a", { tabId: "one", userUnseenCount: 2, unreadCount: 9 }),
      mailbox("a", { tabId: "two", userUnseenCount: 1 }),
      // An older entry without `userUnseenCount` falls back to `unreadCount`.
      mailbox("b", { userUnseenCount: undefined as never, unreadCount: 4 }),
      mailbox("c", { failedInjectCount: 1 }),
      mailbox("d"),
    ],
  });
  expect(markers.get("a")).toEqual({ agentMailUnread: 3 });
  expect(markers.get("b")).toEqual({ agentMailUnread: 4 });
  expect(markers.get("c")).toEqual({ agentMailFailed: true });
  // Nothing to show leaves no marker, so the summary row stays unchanged.
  expect(markers.has("d")).toBe(false);
});

test("mail markers are bounded", () => {
  const markers = environmentMailMarkers({
    revision: 1,
    mailboxes: [mailbox("a", { userUnseenCount: MAX_SUMMARY_MAIL_COUNT + 50 })],
  });
  expect(markers.get("a")).toEqual({ agentMailUnread: MAX_SUMMARY_MAIL_COUNT });
});

test("a pipeline record is working by the shared build-pipeline rule", () => {
  expect(isWorkingPipelineRecord({ snapshot: { phase: "building" } })).toBe(true);
  expect(isWorkingPipelineRecord({ snapshot: { phase: "complete" } })).toBe(false);
  expect(isWorkingPipelineRecord({ snapshot: { phase: "creating-environment" } })).toBe(false);
  expect(
    isWorkingPipelineRecord({
      snapshot: { phase: "building", stallWarning: { sessionId: "s", detectedAt: "t" } },
    }),
  ).toBe(false);
  expect(isWorkingPipelineRecord({ snapshot: null })).toBe(false);
  expect(isWorkingPipelineRecord({ snapshot: { phase: 3 } })).toBe(false);
});
