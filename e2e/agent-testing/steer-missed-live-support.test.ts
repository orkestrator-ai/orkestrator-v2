import { describe, expect, test } from "bun:test";
import { finalReply, scriptedStep } from "./idle-observation-fake-claude";
import {
  backgroundTaskPrompt,
  backgroundTaskSettled,
  composerControls,
  isNoControlChannelRefusal,
  longTurnPrompt,
  messageText,
  replyPrompt,
  rowsCarrying,
  selectedMissedSteerPlatforms,
} from "./steer-missed-live-support";

describe("selectedMissedSteerPlatforms", () => {
  test("defaults to every platform with steer", () => {
    expect([...selectedMissedSteerPlatforms({})]).toEqual(["claude", "codex", "cursor", "pi"]);
  });

  test("narrows to the named platforms", () => {
    expect([
      ...selectedMissedSteerPlatforms({
        ORKESTRATOR_AGENT_TEST_MISSED_STEER_PLATFORMS: " pi, codex ",
      }),
    ]).toEqual(["pi", "codex"]);
  });

  test("refuses a platform it does not know rather than skipping it", () => {
    expect(() =>
      selectedMissedSteerPlatforms({
        ORKESTRATOR_AGENT_TEST_MISSED_STEER_PLATFORMS: "claude,grok",
      }),
    ).toThrow(/not grok/);
  });
});

describe("the prompts the scripted models answer", () => {
  test("a reply prompt ends with exactly its word", () => {
    expect(finalReply(replyPrompt("MISSED-1A2B"))).toBe("MISSED-1A2B");
    expect(scriptedStep(replyPrompt("MISSED-1A2B"), false)).toEqual({
      kind: "text",
      text: "MISSED-1A2B",
    });
  });

  test("a long turn runs one shell command, or holds the fake Cursor run", () => {
    expect(scriptedStep(longTurnPrompt("claude", "LONG-1", 25), false)).toEqual({
      kind: "shell",
      command: "sleep 25; echo LONG-1",
      background: false,
    });
    expect(longTurnPrompt("cursor", "LONG-1", 25)).toContain("HOLD");
  });

  test("the background prompt starts a background command and replies its word", () => {
    const prompt = backgroundTaskPrompt("BG-1", "STARTED-1", 900);
    expect(scriptedStep(prompt, false)).toEqual({
      kind: "shell",
      command: "sleep 900; echo BG-1",
      background: true,
    });
    expect(finalReply(prompt)).toBe("STARTED-1");
  });
});

describe("transcript reads", () => {
  const messages = [
    { role: "user", parts: [{ type: "text", text: "Reply with exactly W-1 and nothing else." }] },
    { role: "assistant", parts: [{ type: "text", text: "W-1" }] },
    { role: "assistant", content: "W-1 again" },
    { role: "assistant", content: [{ type: "text", text: "other" }] },
  ];

  test("text comes from parts first, then content", () => {
    expect(messageText(messages[0]!)).toContain("W-1");
    expect(messageText(messages[2]!)).toBe("W-1 again");
    expect(messageText(messages[3]!)).toBe("other");
    expect(messageText({ role: "assistant" })).toBe("");
  });

  test("rows are counted per role", () => {
    expect(rowsCarrying(messages, "user", "W-1")).toBe(1);
    expect(rowsCarrying(messages, "assistant", "W-1")).toBe(2);
    expect(rowsCarrying(messages, "assistant", "absent")).toBe(0);
  });

  test("controls read as nulls when the composer reports none", () => {
    expect(composerControls(undefined)).toEqual({
      modelId: null,
      modeId: null,
      approvalModeId: null,
    });
    expect(
      composerControls({
        selectedModelId: "m",
        selectedModeId: "build",
        selectedApprovalModeId: "a",
      }),
    ).toEqual({ modelId: "m", modeId: "build", approvalModeId: "a" });
  });
});

describe("background task reads", () => {
  test("only an ending counts as settled", () => {
    expect(backgroundTaskSettled("killed")).toBe(true);
    expect(backgroundTaskSettled("completed")).toBe(true);
    expect(backgroundTaskSettled("failed")).toBe(true);
    expect(backgroundTaskSettled("running")).toBe(false);
    expect(backgroundTaskSettled("paused")).toBe(false);
    expect(backgroundTaskSettled(undefined)).toBe(false);
  });

  test("the no-control-channel refusal is the bridge's 409, relayed by the backend", () => {
    expect(
      isNoControlChannelRefusal(
        "Claude background task stop failed (HTTP 409): No live Claude control channel can reach this task",
      ),
    ).toBe(true);
    expect(
      isNoControlChannelRefusal("Claude background task stop failed (HTTP 404): Task not found"),
    ).toBe(false);
  });
});
