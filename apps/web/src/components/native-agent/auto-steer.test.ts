import { describe, expect, test } from "bun:test";
import {
  autoSteerNotice,
  directSteerNotice,
  queuedSteerNote,
  shouldAutoSteer,
  steerRefusalNote,
  updateSteerRefusals,
} from "./auto-steer";

const eligible = {
  enabled: true,
  steerAvailable: true,
  command: false,
  preparedPrompt: false,
  attachmentCount: 0,
  pendingHandoff: false,
};

describe("shouldAutoSteer", () => {
  test("steers a plain message while the setting is on and the turn can be steered", () => {
    expect(shouldAutoSteer(eligible)).toBe(true);
  });

  test("queues whenever the setting is off or the message cannot steer", () => {
    expect(shouldAutoSteer({ ...eligible, enabled: false })).toBe(false);
    expect(shouldAutoSteer({ ...eligible, steerAvailable: false })).toBe(false);
    expect(shouldAutoSteer({ ...eligible, command: true })).toBe(false);
    expect(shouldAutoSteer({ ...eligible, preparedPrompt: true })).toBe(false);
    expect(shouldAutoSteer({ ...eligible, attachmentCount: 1 })).toBe(false);
    expect(shouldAutoSteer({ ...eligible, pendingHandoff: true })).toBe(false);
  });
});

describe("autoSteerNotice", () => {
  test("confirms a delivered steer", () => {
    expect(autoSteerNotice({ outcome: "applied" }, "Codex")).toEqual({
      tone: "success",
      message: "Steered the active Codex turn",
    });
  });

  test("leaves an unconfirmed steer to the recovery card", () => {
    expect(autoSteerNotice({ outcome: "unknown", requestId: "r-1" }, "Codex")).toBeNull();
  });

  test("says the message stayed queued when the steer did not land", () => {
    expect(autoSteerNotice({ outcome: "idle" }, "Codex")?.message).toBe(
      "Codex finished the turn before it could be steered, so your message is queued.",
    );
    expect(autoSteerNotice({ outcome: "mismatch" }, "Codex")?.message).toMatch(/queued instead\.$/);
    const rejected = autoSteerNotice(
      {
        outcome: "rejected",
        reason: "steer-capacity-exceeded",
        requestId: "r-2",
        message: "Steering is full for this turn.",
      },
      "Codex",
    );
    expect(rejected).toEqual({
      tone: "info",
      message:
        "The last steer attempt was refused because steering was full at the time. Your message remains queued.",
    });
  });

  test("reports a message the queue already sent as the next turn", () => {
    expect(autoSteerNotice(null, "Codex")?.message).toBe(
      "Codex finished the turn first, so your message was sent as the next turn.",
    );
  });
});

describe("queuedSteerNote", () => {
  const steerable = {
    running: true,
    providerSteers: true,
    parked: false,
    steerable: true,
    attachmentCount: 0,
    command: false,
    label: "Claude",
  };

  test("says nothing when the row can be steered or there is no turn to steer", () => {
    expect(queuedSteerNote(steerable)).toBeUndefined();
    expect(queuedSteerNote({ ...steerable, running: false, providerSteers: false })).toBe(
      undefined,
    );
  });

  test("names why a row waits for the turn to end", () => {
    expect(queuedSteerNote({ ...steerable, providerSteers: false })).toBe(
      "Claude cannot be steered here, so this is sent when the turn ends.",
    );
    expect(queuedSteerNote({ ...steerable, parked: true })).toContain("recovery controls");
    expect(queuedSteerNote({ ...steerable, steerable: false, attachmentCount: 1 })).toContain(
      "text only",
    );
    expect(queuedSteerNote({ ...steerable, steerable: false, command: true })).toContain(
      "Commands run as their own turn",
    );
  });

  test("recovery takes priority over a historical refusal even after the turn ends", () => {
    expect(
      queuedSteerNote({ ...steerable, running: false, parked: true, refusal: "Old refusal" }),
    ).toContain("recovery controls");
  });

  test("a refusal is historical context even when another steer is available", () => {
    expect(queuedSteerNote({ ...steerable, refusal: "Steering is full." })).toBe(
      "Steering is full.",
    );
  });
});

describe("steerRefusalNote", () => {
  test("only a steer that left the message queued leaves a note", () => {
    expect(steerRefusalNote({ outcome: "applied" }, "Claude")).toBeUndefined();
    expect(steerRefusalNote({ outcome: "unknown", requestId: "r" }, "Claude")).toBeUndefined();
    expect(steerRefusalNote(null, "Claude")).toBeUndefined();
    expect(steerRefusalNote({ outcome: "mismatch" }, "Claude")).toBe(
      "The last steer attempt missed the active turn. This message remains queued.",
    );
    expect(steerRefusalNote({ outcome: "idle" }, "Claude")).toBe(
      "Claude finished the turn before the last steer attempt. This message remains queued.",
    );
  });
});

for (const reason of [
  "steer-capacity-exceeded",
  "steer-history-unavailable",
  "steer-not-recorded",
] as const) {
  test(`queued rejection ${reason} never asks for another send`, () => {
    const outcome = { outcome: "rejected" as const, reason, requestId: "r" };
    expect(steerRefusalNote(outcome, "Claude")).toContain("remains queued");
    expect(steerRefusalNote(outcome, "Claude")).not.toMatch(/send.*again|sent when/i);
    expect(autoSteerNotice(outcome, "Claude")?.message).not.toMatch(/send.*again/i);
  });
}

test("current provider and item blockers override historical refusals", () => {
  const input = {
    running: true,
    providerSteers: false,
    parked: false,
    steerable: true,
    attachmentCount: 0,
    command: false,
    label: "Claude",
    refusal: "Old refusal",
  };
  expect(queuedSteerNote(input)).toContain("cannot be steered");
  expect(
    queuedSteerNote({ ...input, providerSteers: true, steerable: false, attachmentCount: 1 }),
  ).toContain("attachments");
  expect(
    queuedSteerNote({ ...input, providerSteers: true, steerable: false, command: true }),
  ).toContain("Commands");
});

test("refusal history evicts the oldest and clears a successful retry without mutating snapshots", () => {
  let history: ReadonlyMap<string, string> = new Map();
  for (let i = 0; i < 32; i++) history = updateSteerRefusals(history, String(i), "refused");
  const snapshot = history;
  history = updateSteerRefusals(history, "0", "retried");
  history = updateSteerRefusals(history, "32", "refused");
  expect(history.size).toBe(32);
  expect(history.has("1")).toBe(false);
  expect(history.get("0")).toBe("retried");
  expect(snapshot.has("1")).toBe(true);
  history = updateSteerRefusals(history, "0", steerRefusalNote({ outcome: "applied" }, "Claude"));
  expect(history.has("0")).toBe(false);
  expect(updateSteerRefusals(history, "absent", undefined)).toBe(history);
});

describe("directSteerNotice", () => {
  test("names the turn a steer reached", () => {
    expect(directSteerNotice({}, "Codex")).toEqual({
      tone: "success",
      message: "Sent to the active Codex turn",
    });
    expect(directSteerNotice({}, "Codex", "the active turn")).toEqual({
      tone: "success",
      message: "Sent to the active turn",
    });
  });

  test("says how a steer that missed its turn was delivered, never as an error", () => {
    expect(directSteerNotice({ deliveredAs: "new-turn" }, "Codex")).toEqual({
      tone: "info",
      message: "Codex finished the turn first, so your message was sent as a new turn.",
    });
    expect(directSteerNotice({ deliveredAs: "queued" }, "Codex")).toEqual({
      tone: "info",
      message: "Your message missed the active turn, so it was queued as the next turn.",
    });
  });
});
