import { describe, expect, test } from "bun:test";
import type { AgentPendingInteractionSummary } from "@orkestrator/protocol/agent-registry";
import {
  environmentAttentionText,
  environmentRowModel,
  formatWaitingDuration,
  type EnvironmentRowFacts,
} from "./environment-row-model";

const NOW = Date.parse("2026-11-19T10:00:00Z");

function facts(overrides: Partial<EnvironmentRowFacts> = {}): EnvironmentRowFacts {
  return {
    environmentId: "env-1",
    name: "feature",
    projectHome: false,
    environmentType: "local",
    status: "running",
    deleting: false,
    deleteFailure: null,
    deletingSince: null,
    deletingStep: null,
    deletionRetryable: false,
    buildPipeline: false,
    prState: null,
    autoMerge: false,
    activity: "idle",
    running: true,
    live: true,
    busy: false,
    hasUnreadWork: false,
    unreadReason: null,
    lastActivityAt: "2026-11-19T09:52:00Z",
    prMergeState: null,
    machine: null,
    writable: true,
    dockerAvailable: true,
    localCheckoutAvailable: true,
    ...overrides,
  };
}

const attention = (overrides: Partial<EnvironmentRowFacts>) =>
  environmentRowModel(facts(overrides)).attention;

const pending: AgentPendingInteractionSummary = {
  interactionId: "approval-1",
  kind: "command-approval",
  label: "Needs approval",
  detail: "Run bun install",
  since: Date.parse("2026-11-19T09:55:00Z"),
  count: 1,
};

describe("a row's attention line", () => {
  test("idle and seen, or working, shows no line", () => {
    expect(attention({})).toBeNull();
    expect(attention({ activity: "working" })).toBeNull();
    // What it finished earlier waits until it stops working again.
    expect(
      attention({ activity: "working", hasUnreadWork: true, unreadReason: "agent_finished" }),
    ).toBeNull();
  });

  test("waiting says how long, and names the request once its machine reports it", () => {
    const waiting = attention({ activity: "waiting" })!;
    expect(waiting).toMatchObject({ tone: "waiting", readsPending: true });
    expect(environmentAttentionText(waiting, null, NOW)).toBe("Waiting for you · 8 min");
    expect(environmentAttentionText(waiting, pending, NOW)).toBe(
      "Needs approval: Run bun install · 5 min",
    );
    expect(
      environmentAttentionText(waiting, { ...pending, detail: undefined, count: 3 }, NOW),
    ).toBe("Needs approval · 5 min · 3 waiting");
    const question = attention({
      activity: "waiting",
      hasUnreadWork: true,
      unreadReason: "agent_question",
    })!;
    expect(environmentAttentionText(question, null, NOW)).toBe("Question for you · 8 min");
  });

  test("a waiting agent on a stopped or unreachable machine is not claimed to wait", () => {
    expect(attention({ activity: "waiting", running: false })).toBeNull();
    // Unread work is durable, so it still shows from the last observation.
    expect(
      attention({
        activity: "waiting",
        live: false,
        hasUnreadWork: true,
        unreadReason: "agent_waiting",
      }),
    ).toMatchObject({ tone: "unread", text: "Stopped for input · unread", readsPending: false });
  });

  test("unread work says what finished", () => {
    const text = (unreadReason: EnvironmentRowFacts["unreadReason"]) =>
      attention({ hasUnreadWork: true, unreadReason });
    expect(text("agent_finished")).toMatchObject({
      tone: "unread",
      text: "Finished · result unread",
    });
    expect(text("terminal_finished")?.text).toBe("Finished · result unread");
    expect(text("agent_failed")).toMatchObject({ tone: "failed", text: "Failed · error unread" });
    expect(text("agent_question")?.text).toBe("Asked a question · unread");
    expect(text("setup_approval")).toMatchObject({
      tone: "setup",
      text: "Setup needs your approval",
    });
    expect(text("marked_unread")?.text).toBe("Marked unread");
    expect(text(null)?.text).toBe("New activity · unread");
    // Pending detail never replaces unread wording.
    expect(environmentAttentionText(text("agent_finished")!, pending, NOW)).toBe(
      "Finished · result unread",
    );
  });

  test("a row being deleted, or whose delete failed, shows no line", () => {
    expect(attention({ activity: "waiting", deleting: true })).toBeNull();
    expect(attention({ hasUnreadWork: true, deleteFailure: "x" })).toBeNull();
  });

  test("waiting durations", () => {
    expect(formatWaitingDuration(NOW - 10_000, NOW)).toBe("just now");
    expect(formatWaitingDuration(NOW - 8 * 60_000, NOW)).toBe("8 min");
    expect(formatWaitingDuration(NOW - 3 * 3_600_000, NOW)).toBe("3 h");
    expect(formatWaitingDuration(NOW - 2 * 86_400_000, NOW)).toBe("2 d");
    // Another machine's clock may run ahead.
    expect(formatWaitingDuration(NOW + 60_000, NOW)).toBe("just now");
    expect(formatWaitingDuration(Number.NaN, NOW)).toBeNull();
  });
});
