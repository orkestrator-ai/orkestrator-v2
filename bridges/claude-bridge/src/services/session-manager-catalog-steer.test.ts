import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createSession, track } from "./session-manager-test-harness.js";
import {
  answerIdleSteerPrompt,
  readClaudeSteerDispatch,
  steerClaudeSession,
} from "./session-manager.js";

describe("Claude steer journal and transcript", () => {
  test("pushes once, records the user row, and is idempotent for the same request", () => {
    const session = createSession("Steer");
    track(session.id);
    const pushed: unknown[] = [];
    session.status = "running";
    session.latestTurnGeneration = 7;
    session.queryControl = {
      pushInput: (message) => {
        pushed.push(message);
        return true;
      },
    };

    expect(steerClaudeSession(session.id, "narrow the scope", "steer-1", "7")).toBe("applied");
    expect(steerClaudeSession(session.id, "narrow the scope", "steer-1", "7")).toBe("applied");
    expect(pushed).toHaveLength(1);
    expect(readClaudeSteerDispatch(session.id, "steer-1")).toBe("dispatched");
    expect(session.messages).toEqual([
      expect.objectContaining({
        id: "steer:steer-1",
        role: "user",
        content: "narrow the scope",
      }),
    ]);
  });

  test("refuses a reused request id that carries different text", () => {
    const session = createSession("Steer conflict");
    track(session.id);
    session.status = "running";
    session.latestTurnGeneration = 3;
    session.queryControl = { pushInput: () => true };

    expect(steerClaudeSession(session.id, "first", "steer-dup", "3")).toBe("applied");
    expect(steerClaudeSession(session.id, "second", "steer-dup", "3")).toBe("unknown");
    expect(session.messages).toHaveLength(1);
  });

  test("answers idle when nothing is running and does not invent a turn", () => {
    const session = createSession("Idle steer");
    track(session.id);
    expect(steerClaudeSession(session.id, "too late", "steer-idle", "1")).toBe("idle");
    expect(readClaudeSteerDispatch(session.id, "steer-idle")).toBe("absent");
    expect(session.messages).toEqual([]);
  });

  test("pins the expected run and splits the live assistant row", () => {
    const session = createSession("Split");
    track(session.id);
    const splits: string[] = [];
    session.status = "running";
    session.latestTurnGeneration = 2;
    session.queryControl = { pushInput: () => true };
    session.splitAssistantAfterSteer = () => {
      splits.push("split");
    };

    expect(steerClaudeSession(session.id, "stop", "steer-split", "1")).toBe("mismatch");
    expect(steerClaudeSession(session.id, "stop", "steer-split", "2")).toBe("applied");
    expect(splits).toEqual(["split"]);
    expect(session.steerJournal?.get("steer-split")?.inputDigest).toBe(
      createHash("sha256").update("stop").digest("hex"),
    );
  });

  test("writes an idle /steer as a local transcript pair", () => {
    const session = createSession("Local idle");
    track(session.id);
    const reply = answerIdleSteerPrompt(session, "/steer keep going");
    expect(reply).toContain("no active Claude turn to steer");
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1]?.content).toContain("no active Claude turn to steer");
  });
});
