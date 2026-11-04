import { describe, expect, test } from "bun:test";
import { autoSteerNotice, queuedSteerNote, shouldAutoSteer, steerRefusalNote } from "./auto-steer";

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
      message: "Steering is full for this turn. Your message was queued instead.",
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
    expect(queuedSteerNote({ ...steerable, parked: true })).toContain("still being confirmed");
    expect(queuedSteerNote({ ...steerable, steerable: false, attachmentCount: 1 })).toContain(
      "text only",
    );
    expect(queuedSteerNote({ ...steerable, steerable: false, command: true })).toContain(
      "Commands run as their own turn",
    );
  });

  test("a refusal is what happened to this row, so it wins", () => {
    expect(
      queuedSteerNote({ ...steerable, providerSteers: false, refusal: "Steering is full." }),
    ).toBe("Steering is full.");
  });
});

describe("steerRefusalNote", () => {
  test("only a steer that left the message queued leaves a note", () => {
    expect(steerRefusalNote({ outcome: "applied" }, "Claude")).toBeUndefined();
    expect(steerRefusalNote({ outcome: "unknown", requestId: "r" }, "Claude")).toBeUndefined();
    expect(steerRefusalNote(null, "Claude")).toBeUndefined();
    expect(steerRefusalNote({ outcome: "mismatch" }, "Claude")).toBe(
      "The turn moved on before this could be steered. Sent when the turn ends.",
    );
    expect(steerRefusalNote({ outcome: "idle" }, "Claude")).toBe(
      "Claude finished the turn before this could be steered. Sent as the next turn.",
    );
  });
});
