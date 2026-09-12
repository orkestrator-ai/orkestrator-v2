import "./testing/unit-test-env.js";
import { describe, expect, test } from "bun:test";
import type { AcpProcess, SessionState } from "./acp-context.js";
import { ensureSessionProcess } from "./acp-session.js";

describe("ensureSessionProcess fingerprint", () => {
  test("a session created without agentMcp keeps the same child", async () => {
    let closed = 0;
    const child = {
      close: async () => {
        closed += 1;
      },
    } as AcpProcess;
    const state = {
      child,
      approvals: new Map(),
      status: "idle",
    } as SessionState;

    const first = await ensureSessionProcess(state);
    const second = await ensureSessionProcess(state);
    expect(first).toBe(child);
    expect(second).toBe(child);
    expect(closed).toBe(0);
  });
});
