import { describe, expect, test } from "bun:test";
import type { AgentMailMessageSummary } from "@orkestrator/protocol/agent-mail";
import { accountSwitchRowsFromMailbox, withAccountSwitchRows } from "./account-switch-rows";
import type { NativeMessage } from "./native-message-types";

function switchMail(
  id: string,
  createdAt: string,
  placement: AgentMailMessageSummary["placement"] = "pending-inject",
): AgentMailMessageSummary {
  return {
    version: 1,
    id,
    threadId: id,
    requestId: id,
    createdAt,
    from: {
      kind: "system",
      projectId: "project",
      source: "workflow",
      resourceId: "account-auto-switch:claude",
    },
    toEnvironmentId: "coordinator",
    toTabId: "main",
    toIncarnationId: "inc",
    subject: "Claude Code moved to b@example.com on mini",
    bodyBytes: 10,
    trust: "same-project",
    injectDepth: 0,
    threadDepth: 0,
    notice: {
      resource: { kind: "account-switch", id: "claude", label: "mini" },
      accountSwitch: { provider: "Claude Code", from: "a@example.com", to: "b@example.com" },
      state: "account-switched",
      tone: "info",
    },
    rideAlong: true,
    placement,
    revision: 1,
  };
}

function row(id: string, createdAt: string): NativeMessage {
  return { id, role: "assistant", content: id, parts: [], createdAt };
}

describe("account-switch rows from the mailbox", () => {
  test("draws every switch the transcript cannot show yet, as one-line notice rows", () => {
    const rows = accountSwitchRowsFromMailbox([
      switchMail("waiting", "2026-11-14T10:00:00.000Z"),
      switchMail("filed", "2026-11-14T09:00:00.000Z", "stored"),
      switchMail("lapsed", "2026-11-13T09:00:00.000Z", "expired"),
      switchMail("delivered", "2026-11-14T08:00:00.000Z", "injected"),
      switchMail("muted", "2026-11-14T08:30:00.000Z", "bounced"),
      { ...switchMail("other", "2026-11-14T08:45:00.000Z"), notice: undefined },
    ]);
    expect(rows.map((entry) => entry.id)).toEqual([
      "peer-mail-lapsed",
      "peer-mail-filed",
      "peer-mail-waiting",
    ]);
    expect(rows[0]!.peerMail?.notice?.accountSwitch).toEqual({
      provider: "Claude Code",
      from: "a@example.com",
      to: "b@example.com",
    });
  });

  test("only a workflow sender's switch counts", () => {
    const forged = {
      ...switchMail("forged", "2026-11-14T10:00:00.000Z"),
      from: { kind: "user" as const },
    };
    expect(accountSwitchRowsFromMailbox([forged])).toEqual([]);
  });
});

describe("placing them in the transcript", () => {
  const [pending] = accountSwitchRowsFromMailbox([
    switchMail("switch", "2026-11-14T10:00:00.000Z"),
  ]);

  test("goes in by time", () => {
    const merged = withAccountSwitchRows(
      [row("before", "2026-11-14T09:00:00.000Z"), row("after", "2026-11-14T11:00:00.000Z")],
      [pending!],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["before", "peer-mail-switch", "after"]);
    expect(withAccountSwitchRows([], [pending!]).map((entry) => entry.id)).toEqual([
      "peer-mail-switch",
    ]);
  });

  test("is not drawn twice once its carrier is in the transcript", () => {
    const delivered = { ...pending!, createdAt: "2026-11-14T12:00:00.000Z" };
    const merged = withAccountSwitchRows(
      [row("before", "2026-11-14T09:00:00.000Z"), delivered],
      [pending!],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["before", "peer-mail-switch"]);
  });

  test("stays out of a window whose earlier history is not loaded", () => {
    const transcript = [row("later", "2026-11-14T11:00:00.000Z")];
    expect(withAccountSwitchRows(transcript, [pending!], { earlierHistoryUnloaded: true })).toBe(
      transcript,
    );
    expect(withAccountSwitchRows(transcript, [pending!]).map((entry) => entry.id)).toEqual([
      "peer-mail-switch",
      "later",
    ]);
  });
});
