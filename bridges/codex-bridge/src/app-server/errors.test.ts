import { describe, expect, test } from "bun:test";
import {
  APP_SERVER_OVERLOAD_CODE,
  AppServerCircuitOpenError,
  AppServerProcessExitError,
  AppServerProtocolError,
  AppServerRpcError,
  AppServerTimeoutError,
  AppServerUnavailableError,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  classifyDispatchFailure,
  codexErrorInfoToCode,
  isMissingRolloutError,
  isPaginatedHistoryUnsupportedError,
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

  test("classifies only an explicit overload as a rejected dispatch", () => {
    const rpc = (code: number) =>
      new AppServerRpcError("turn/start", { code, message: `code ${code}` });

    // Referencing the constant rather than -32001: if the documented overload
    // code ever moves, this must fail rather than silently keep retrying a code
    // that no longer promises non-execution.
    expect(classifyDispatchFailure(rpc(APP_SERVER_OVERLOAD_CODE))).toBe("rejected");

    // Everything else may have been acted on before the error came back, so it
    // has to be reconciled against thread/read instead of retried.
    for (const code of [
      JSON_RPC_INVALID_REQUEST,
      JSON_RPC_METHOD_NOT_FOUND,
      JSON_RPC_INVALID_PARAMS,
      JSON_RPC_INTERNAL_ERROR,
      -32000,
      1234,
      0,
    ]) {
      expect(classifyDispatchFailure(rpc(code))).toBe("ambiguous");
    }

    for (const error of [
      new AppServerTimeoutError("turn/start", 10),
      new AppServerProcessExitError("gone", { generation: 2 }),
      new AppServerProtocolError("bad frame"),
      new AppServerUnavailableError("draining"),
      new AppServerCircuitOpenError(3),
      new Error("write EPIPE"),
      "boom",
      undefined,
    ]) {
      expect(classifyDispatchFailure(error)).toBe("ambiguous");
    }
  });

  test("refuses an immediate retry for every non-overload failure", () => {
    expect(
      isSafeToRetryImmediately(
        new AppServerRpcError("turn/start", {
          code: JSON_RPC_INTERNAL_ERROR,
          message: "boom",
        }),
      ),
    ).toBe(false);
    expect(isSafeToRetryImmediately(new AppServerTimeoutError("turn/start", 1))).toBe(false);
    expect(isSafeToRetryImmediately(new Error("overload"))).toBe(false);
  });

  test("maps each transport error class into a stable engine error", () => {
    expect(
      toEngineError(
        new AppServerRpcError("turn/start", {
          code: -32603,
          message: "bad",
          data: { private: true },
        }),
      ),
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
    // Only overload is reported retryable, and only a string `data` is surfaced —
    // arbitrary objects may carry prompt or path content.
    expect(
      toEngineError(
        new AppServerRpcError("turn/start", {
          code: APP_SERVER_OVERLOAD_CODE,
          message: "busy",
          data: "retry shortly",
        }),
      ),
    ).toMatchObject({
      code: String(APP_SERVER_OVERLOAD_CODE),
      retryable: true,
      details: "retry shortly",
    });
    // Circuit-open has no transport code of its own and must fall through to the
    // generic branch rather than being mislabelled as one of the above.
    const circuit = toEngineError(new AppServerCircuitOpenError(4, "spawn failed"));
    expect(circuit.code).toBeUndefined();
    expect(circuit.retryable).toBe(false);
    expect(circuit.message).toContain("4 times");
    expect(toEngineError("plain")).toEqual({ message: "plain", retryable: false });
  });

  test("recognises only the narrow rollout recovery messages", () => {
    const unmaterialized = new AppServerRpcError("thread/read", {
      code: -32600,
      message: "thread is not materialized",
    });
    expect(isUnmaterializedThreadError(unmaterialized)).toBe(true);
    expect(isUnmaterializedThreadError(new Error("not materialized"))).toBe(false);
    // app-server's wording has varied in case; the match must not depend on it.
    expect(
      isUnmaterializedThreadError(
        new AppServerRpcError("thread/read", {
          code: -32600,
          message: "Thread is NOT MATERIALIZED yet",
        }),
      ),
    ).toBe(true);
    const unsupportedLegacy = new AppServerRpcError("thread/read", {
      code: -32601,
      message: "list_turns is not supported yet",
    });
    expect(isPaginatedHistoryUnsupportedError(unsupportedLegacy)).toBe(true);
    expect(
      isPaginatedHistoryUnsupportedError(
        new AppServerRpcError("thread/list", {
          code: -32601,
          message: "list_turns is not supported yet",
        }),
      ),
    ).toBe(false);
    expect(
      isPaginatedHistoryUnsupportedError(
        new AppServerRpcError("thread/read", { code: -32600, message: "not materialized" }),
      ),
    ).toBe(false);
    expect(isUnmaterializedThreadError(unsupportedLegacy)).toBe(false);
    expect(
      isUnmaterializedThreadError(unsupportedLegacy, {
        historyMode: "paginated",
        path: "/tmp/rollout.jsonl",
        preview: "persisted prompt",
        createdAt: 1,
        updatedAt: 2,
        status: { type: "idle" },
      }),
    ).toBe(false);
    const untouched = {
      historyMode: "paginated",
      path: "/tmp/rollout.jsonl",
      preview: "",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
    };
    expect(isUnmaterializedThreadError(unsupportedLegacy, untouched)).toBe(true);
    for (const changed of [
      { ...untouched, historyMode: "legacy" },
      { ...untouched, historyMode: undefined },
      { ...untouched, preview: "persisted prompt" },
      { ...untouched, updatedAt: 2 },
      { ...untouched, createdAt: undefined, updatedAt: undefined },
      { ...untouched, createdAt: "1", updatedAt: "1" },
      { ...untouched, status: { type: "running" } },
      { ...untouched, status: undefined },
    ]) {
      expect(isUnmaterializedThreadError(unsupportedLegacy, changed)).toBe(false);
    }
    expect(isMissingRolloutError("thread/resume: no rollout found for thread id t1")).toBe(true);
    expect(isMissingRolloutError("thread/read: no rollout found for thread id t1")).toBe(false);
    // The message usually arrives wrapped in an Error, not as a bare string.
    expect(
      isMissingRolloutError(
        new AppServerRpcError("thread/resume", {
          code: -32603,
          message: "No rollout found for thread id t1",
        }),
      ),
    ).toBe(true);
    expect(isMissingRolloutError(new Error("thread/resume failed: spawn error"))).toBe(false);
    expect(isMissingRolloutError(undefined)).toBe(false);
  });

  test("normalizes Codex error discriminants without guessing malformed objects", () => {
    expect(codexErrorInfoToCode("usageLimit")).toBe("usageLimit");
    expect(codexErrorInfoToCode({ contextWindowExceeded: {} })).toBe("contextWindowExceeded");
    expect(codexErrorInfoToCode({ a: 1, b: 2 })).toBeUndefined();
    expect(codexErrorInfoToCode(null)).toBeUndefined();
  });
});
