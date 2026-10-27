import { describe, expect, mock, test } from "bun:test";
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import {
  recordPipelineSessionUsage,
  sharedTranscriptRead,
} from "./build-pipeline-session-usage.js";

function session(tokenCount?: number): PipelineSession {
  return {
    phase: "build",
    iteration: 0,
    sessionKey: "pipeline-1:build:0:a",
    sdkSessionId: "build-1",
    status: "running",
    startedAt: "2026-10-27T00:00:00.000Z",
    label: "Build",
    ...(tokenCount === undefined ? {} : { tokenCount }),
  };
}

describe("recordPipelineSessionUsage", () => {
  test("copies the observation's cumulative count onto a running session", async () => {
    const target = session();
    expect(await recordPipelineSessionUsage(target, {}, { sessionTokens: 1_200 }, undefined)).toBe(
      true,
    );
    expect(target.tokenCount).toBe(1_200);
    // An unchanged count is not a change, so it never forces a save.
    expect(await recordPipelineSessionUsage(target, {}, { sessionTokens: 1_200 }, undefined)).toBe(
      false,
    );
  });

  test("keeps the largest count seen", async () => {
    const target = session(5_000);
    expect(await recordPipelineSessionUsage(target, {}, { sessionTokens: 900 }, undefined)).toBe(
      false,
    );
    expect(target.tokenCount).toBe(5_000);
  });

  test("meters from the transcript this pass read when the observation has no count", async () => {
    const target = session();
    const usageFromMessages = mock((messages: readonly unknown[]) => ({
      usedTokens: 10,
      sessionTokens: messages.length * 100,
    }));
    expect(
      await recordPipelineSessionUsage(
        target,
        { usageFromMessages },
        undefined,
        Promise.resolve([{}, {}, {}]),
      ),
    ).toBe(true);
    expect(target.tokenCount).toBe(300);
  });

  test("prefers the observation over the transcript", async () => {
    const target = session();
    const usageFromMessages = mock(() => ({ usedTokens: 1, sessionTokens: 1 }));
    await recordPipelineSessionUsage(
      target,
      { usageFromMessages },
      { sessionTokens: 42 },
      Promise.resolve([]),
    );
    expect(target.tokenCount).toBe(42);
    expect(usageFromMessages).not.toHaveBeenCalled();
  });

  test("leaves the session alone when nothing reported usage", async () => {
    const target = session();
    const usageFromMessages = mock(() => ({ usedTokens: 1, sessionTokens: 1 }));
    // No transcript read this pass: metering never adds one.
    expect(
      await recordPipelineSessionUsage(target, { usageFromMessages }, undefined, undefined),
    ).toBe(false);
    expect(
      await recordPipelineSessionUsage(target, {}, { sessionTokens: -1 }, Promise.resolve([])),
    ).toBe(false);
    expect(
      await recordPipelineSessionUsage(target, {}, { sessionTokens: 1.5 }, Promise.resolve([])),
    ).toBe(false);
    expect(target.tokenCount).toBeUndefined();
  });

  test("a failing meter never fails the stage", async () => {
    const target = session(7);
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    try {
      expect(
        await recordPipelineSessionUsage(
          target,
          { usageFromMessages: () => ({ usedTokens: 1, sessionTokens: 1 }) },
          undefined,
          Promise.reject(new Error("transcript unavailable")),
        ),
      ).toBe(false);
    } finally {
      console.warn = original;
    }
    expect(target.tokenCount).toBe(7);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("sharedTranscriptRead", () => {
  test("reads once and exposes the read only after it was taken", async () => {
    const messages = mock(async () => [{ id: "m1" }]);
    const shared = sharedTranscriptRead({ messages }, "build-1");
    expect(shared.taken()).toBeUndefined();
    const first = shared.read();
    expect(shared.read()).toBe(first);
    expect(shared.taken()).toBe(first);
    expect(await first).toEqual([{ id: "m1" }]);
    expect(messages).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledWith("build-1");
  });
});
