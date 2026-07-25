import { describe, expect, test } from "bun:test";
import {
  AppServerCircuitOpenError,
  AppServerProcessExitError,
  AppServerProtocolError,
  AppServerRpcError,
  AppServerTimeoutError,
  AppServerUnavailableError,
  codexErrorInfoToCode,
  isMissingRolloutError,
  isSafeToRetryImmediately,
  isUnmaterializedThreadError,
  toEngineError,
} from "./errors.js";

describe("app-server error taxonomy", () => {
  test("constructors retain the metadata needed by recovery and diagnostics", () => {
    const rpc = new AppServerRpcError("turn/start", {
      code: -32001,
      message: "busy",
      data: "later",
    });
    expect(rpc).toMatchObject({ method: "turn/start", code: -32001, data: "later" });
    expect(rpc.isOverload()).toBe(true);
    expect(isSafeToRetryImmediately(rpc)).toBe(true);

    expect(new AppServerTimeoutError("thread/read", 25)).toMatchObject({
      method: "thread/read",
      timeoutMs: 25,
    });
    expect(
      new AppServerProcessExitError("gone", {
        generation: 3,
        exitCode: 9,
        signal: "SIGKILL",
        method: "turn/start",
      }),
    ).toMatchObject({
      generation: 3,
      exitCode: 9,
      signal: "SIGKILL",
      method: "turn/start",
    });
    expect(new AppServerProtocolError("bad")).toMatchObject({ detail: "bad" });
    expect(new AppServerUnavailableError("draining", "changed")).toMatchObject({
      state: "draining",
    });
    expect(new AppServerCircuitOpenError(5, "boom")).toMatchObject({ failures: 5 });
  });

  test("maps each transport error class into a stable engine error", () => {
    expect(
      toEngineError(new AppServerRpcError("turn/start", {
        code: -32603,
        message: "bad",
        data: { private: true },
      })),
    ).toMatchObject({ code: "-32603", retryable: false, details: undefined });
    expect(toEngineError(new AppServerTimeoutError("read", 1))).toMatchObject({
      code: "timeout",
    });
    expect(toEngineError(new AppServerProcessExitError("gone", { generation: 1 }))).toMatchObject({
      code: "process-exit",
    });
    expect(toEngineError(new AppServerProtocolError("bad"))).toMatchObject({ code: "protocol" });
    expect(toEngineError(new AppServerUnavailableError("failed"))).toMatchObject({
      code: "unavailable",
    });
    expect(toEngineError("plain")).toEqual({ message: "plain", retryable: false });
  });

  test("recognises only the narrow rollout recovery messages", () => {
    const unmaterialized = new AppServerRpcError("thread/read", {
      code: -32600,
      message: "thread is not materialized",
    });
    expect(isUnmaterializedThreadError(unmaterialized)).toBe(true);
    expect(isUnmaterializedThreadError(new Error("not materialized"))).toBe(false);
    expect(
      isMissingRolloutError("thread/resume: no rollout found for thread id t1"),
    ).toBe(true);
    expect(isMissingRolloutError("thread/read: no rollout found for thread id t1")).toBe(false);
  });

  test("normalizes Codex error discriminants without guessing malformed objects", () => {
    expect(codexErrorInfoToCode("usageLimit")).toBe("usageLimit");
    expect(codexErrorInfoToCode({ contextWindowExceeded: {} })).toBe(
      "contextWindowExceeded",
    );
    expect(codexErrorInfoToCode({ a: 1, b: 2 })).toBeUndefined();
    expect(codexErrorInfoToCode(null)).toBeUndefined();
  });
});
