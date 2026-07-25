import { describe, expect, test } from "bun:test";
import {
  assertValidOutboundMethod,
  classifyInbound,
  extractThreadId,
  extractTurnId,
  parseInboundLine,
} from "./envelope-validation.js";

describe("JSON-RPC envelope validation", () => {
  test("classifies responses, notifications, and server requests in precedence order", () => {
    expect(classifyInbound({ id: 1, result: { ok: true } })).toEqual({
      kind: "response",
      id: 1,
      result: { ok: true },
    });
    expect(classifyInbound({ id: "a", error: { code: -1, data: "detail" } })).toEqual({
      kind: "response",
      id: "a",
      error: { code: -1, message: "unknown error", data: "detail" },
    });
    expect(classifyInbound({ method: "turn/started", params: {}, emittedAtMs: 4 })).toEqual({
      kind: "notification",
      method: "turn/started",
      params: {},
      emittedAtMs: 4,
    });
    expect(classifyInbound({ id: 2, method: "approval", params: { x: 1 } })).toEqual({
      kind: "server-request",
      id: 2,
      method: "approval",
      params: { x: 1 },
    });
  });

  test("rejects malformed ids, responses, error bodies, and non-object envelopes", () => {
    for (const value of [
      null,
      [],
      { id: Number.NaN, result: null },
      { id: Number.POSITIVE_INFINITY, method: "request" },
      { id: 1 },
      { id: 1, error: { code: "bad", message: "no" } },
      { method: "" },
      {},
    ]) {
      expect(classifyInbound(value).kind).toBe("invalid");
    }
  });

  test("parses JSONL defensively and truncates previews", () => {
    expect(parseInboundLine(" \n")).toBeNull();
    expect(parseInboundLine("{broken")).toMatchObject({
      kind: "invalid",
      detail: "line is not valid JSON",
    });
    const invalid = parseInboundLine(`"${"x".repeat(250)}"`);
    expect(invalid).toMatchObject({ kind: "invalid" });
    expect((invalid as { preview: string }).preview.length).toBe(201);
  });

  test("extracts flat and nested thread/turn ids", () => {
    expect(extractThreadId({ threadId: "t1" })).toBe("t1");
    expect(extractThreadId({ thread: { id: "t2" } })).toBe("t2");
    expect(extractThreadId({ threadId: "", thread: { id: 4 } })).toBeNull();
    expect(extractThreadId([])).toBeNull();
    expect(extractTurnId({ turnId: "turn-1" })).toBe("turn-1");
    expect(extractTurnId({ turn: { id: "turn-2" } })).toBe("turn-2");
    expect(extractTurnId(null)).toBeNull();
  });

  test("outbound methods must be non-empty strings", () => {
    expect(() => assertValidOutboundMethod("thread/read")).not.toThrow();
    expect(() => assertValidOutboundMethod("")).toThrow("outbound method must be");
    expect(() => assertValidOutboundMethod(null as never)).toThrow("outbound method must be");
  });
});
