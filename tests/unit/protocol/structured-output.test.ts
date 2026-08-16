import { describe, expect, test } from "bun:test";
import {
  StructuredOutputReadUnavailableError,
  isJsonSchema,
  isStructuredOutputReadUnavailableError,
  isStructuredOutputResult,
  structuredOutputFailure,
  tryParseStructuredOutputText,
} from "../../../packages/protocol/src/structured-output";

describe("structured-output protocol", () => {
  test("recognizes JSON-schema object shapes only", () => {
    expect(isJsonSchema({ type: "object" })).toBe(true);
    expect(isJsonSchema({})).toBe(true);
    expect(isJsonSchema(null)).toBe(false);
    expect(isJsonSchema([])).toBe(false);
    expect(isJsonSchema("object")).toBe(false);
  });

  test("validates success envelopes including falsy values", () => {
    expect(isStructuredOutputResult({
      ok: true,
      provider: "codex",
      requestId: "request-1",
      value: 0,
    })).toBe(true);
    expect(isStructuredOutputResult({
      ok: true,
      provider: "claude",
      value: false,
    })).toBe(true);
    expect(isStructuredOutputResult({
      ok: true,
      provider: "codex",
    })).toBe(false);
    expect(isStructuredOutputResult({
      ok: true,
      provider: "unknown",
      value: {},
    })).toBe(false);
    expect(isStructuredOutputResult({
      ok: true,
      provider: "codex",
      requestId: 42,
      value: {},
    })).toBe(false);
  });

  test("validates failure envelopes and their nested provider and details", () => {
    expect(isStructuredOutputResult({
      ok: false,
      provider: "opencode",
      error: {
        code: "provider_error",
        message: "failed",
        provider: "opencode",
        retryable: true,
        details: { status: 503 },
      },
    })).toBe(true);
    expect(isStructuredOutputResult({
      ok: false,
      provider: "opencode",
      error: {
        code: "not_registered",
        message: "failed",
        provider: "opencode",
        retryable: true,
      },
    })).toBe(false);
    expect(isStructuredOutputResult({
      ok: false,
      provider: "opencode",
      error: {
        code: "provider_error",
        message: "failed",
        provider: "codex",
        retryable: true,
      },
    })).toBe(false);
    expect(isStructuredOutputResult({
      ok: false,
      provider: "opencode",
      error: {
        code: "provider_error",
        message: "failed",
        provider: "opencode",
        retryable: true,
        details: [],
      },
    })).toBe(false);
  });

  test("builds retryable failures with an interrupted default override", () => {
    expect(
      structuredOutputFailure("claude", "malformed_output", "bad output", {
        requestId: "request-1",
        details: { attempt: 2 },
      }),
    ).toEqual({
      ok: false,
      provider: "claude",
      requestId: "request-1",
      error: {
        code: "malformed_output",
        message: "bad output",
        provider: "claude",
        retryable: true,
        details: { attempt: 2 },
      },
    });
    expect(
      structuredOutputFailure("codex", "interrupted", "cancelled"),
    ).toMatchObject({
      error: { retryable: false },
    });
    expect(
      structuredOutputFailure("codex", "interrupted", "cancelled", {
        retryable: true,
      }),
    ).toMatchObject({
      error: { retryable: true },
    });
  });

  test("identifies typed read-unavailable errors and retains reconciliation context", () => {
    const cause = new Error("connection reset");
    const error = new StructuredOutputReadUnavailableError(
      "opencode",
      "message history unavailable",
      { requestId: "request-2", cause },
    );

    expect(error).toBeInstanceOf(Error);
    expect(isStructuredOutputReadUnavailableError(error)).toBe(true);
    expect(isStructuredOutputReadUnavailableError({ code: error.code })).toBe(false);
    expect(error).toMatchObject({
      name: "StructuredOutputReadUnavailableError",
      code: "structured_output_read_unavailable",
      provider: "opencode",
      requestId: "request-2",
      retryable: true,
      cause,
    });
  });

  test("recovers JSON from thinking-prefixed structured output text", () => {
    expect(tryParseStructuredOutputText(
      "The extractor likely scans the entire assistant message.\n{\"ready\":\"yes\"}",
    )).toEqual({ ready: "yes" });
    expect(tryParseStructuredOutputText("I could not verify the build.")).toBeUndefined();
  });
});
