import { describe, expect, test } from "bun:test";
import type { PublicReceipt } from "./public-api.js";
import {
  classifyReceiptForWait,
  nextPublicWaitDelay,
  terminalReceiptErrorCode,
} from "./public-api-wait.js";

function receipt(patch: Partial<PublicReceipt>): PublicReceipt {
  return {
    operationId: "op-1",
    namespace: "ns-1",
    requestId: "r-1",
    action: "session.prompt",
    state: "running",
    stage: "executing",
    replayed: false,
    resources: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    retainedUntil: new Date(0).toISOString(),
    ...patch,
  };
}

describe("classifyReceiptForWait", () => {
  test("terminal, pending and every early stop", () => {
    expect(classifyReceiptForWait(receipt({ state: "succeeded" }))).toEqual({
      kind: "terminal",
      succeeded: true,
    });
    expect(classifyReceiptForWait(receipt({ state: "failed" }))).toEqual({
      kind: "terminal",
      succeeded: false,
    });
    expect(classifyReceiptForWait(receipt({}))).toEqual({ kind: "pending" });
    const waiting = receipt({
      execution: {
        state: "waiting-for-input",
        evidence: "provider-status",
        interactions: [{ id: "q", kind: "question", revision: 1, blocking: true }],
      } as PublicReceipt["execution"],
    });
    expect(classifyReceiptForWait(waiting)).toMatchObject({
      kind: "stopped",
      code: "interaction-required",
      interactions: [{ id: "q" }],
    });
    expect(classifyReceiptForWait(waiting, { continueOnInteraction: true })).toEqual({
      kind: "pending",
    });
    expect(
      classifyReceiptForWait(
        receipt({ state: "unknown", dispatch: { state: "unknown", recoverable: true } }),
      ),
    ).toMatchObject({ kind: "stopped", code: "dispatch-unknown", retryable: true });
    expect(classifyReceiptForWait(receipt({ state: "unknown" }))).toMatchObject({
      kind: "stopped",
      code: "run-unknown",
    });
    expect(
      classifyReceiptForWait(
        receipt({
          execution: {
            state: "unsupported",
            reason: "no completion",
          } as PublicReceipt["execution"],
        }),
      ),
    ).toMatchObject({ kind: "stopped", code: "capability-unavailable", message: "no completion" });
  });

  test("terminal error codes and the CLI's backoff", () => {
    expect(terminalReceiptErrorCode(receipt({ state: "succeeded" }))).toBeNull();
    expect(terminalReceiptErrorCode(receipt({ state: "partial" }))).toBe("partial-failure");
    expect(terminalReceiptErrorCode(receipt({ state: "cancelled" }))).toBe("run-cancelled");
    expect(terminalReceiptErrorCode(receipt({ state: "interrupted" }))).toBe("run-interrupted");
    expect(
      terminalReceiptErrorCode(
        receipt({ state: "failed", error: { code: "exec-failed", message: "x" } }),
      ),
    ).toBe("exec-failed");
    const delays: number[] = [];
    let delay: number | undefined;
    for (let step = 0; step < 6; step += 1) delays.push((delay = nextPublicWaitDelay(delay)));
    expect(delays).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000]);
  });
});
