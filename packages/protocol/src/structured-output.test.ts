import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "./agent-platforms.js";
import {
  StructuredOutputReadUnavailableError,
  isJsonSchema,
  isStructuredOutputReadUnavailableError,
  isStructuredOutputResult,
  structuredOutputFailure,
} from "./structured-output.js";

describe("structured output protocol", () => {
  test("accepts success and failure results from every agent platform", () => {
    for (const provider of AGENT_PLATFORMS) {
      expect(
        isStructuredOutputResult({
          ok: true,
          provider,
          requestId: "request-1",
          value: { ready: true },
        }),
      ).toBe(true);
      expect(
        isStructuredOutputResult(
          structuredOutputFailure(provider, "malformed_output", "The result was not JSON", {
            requestId: "request-1",
          }),
        ),
      ).toBe(true);
    }
  });

  test("keeps Pi failure attribution and retry policy authoritative", () => {
    expect(
      structuredOutputFailure("pi", "interrupted", "The Pi turn was cancelled", {
        requestId: "pi-request",
        details: { phase: "cancelled" },
      }),
    ).toEqual({
      ok: false,
      provider: "pi",
      requestId: "pi-request",
      error: {
        code: "interrupted",
        message: "The Pi turn was cancelled",
        provider: "pi",
        retryable: false,
        details: { phase: "cancelled" },
      },
    });
  });

  test("rejects mismatched providers and malformed payloads", () => {
    expect(
      isStructuredOutputResult({
        ok: false,
        provider: "pi",
        error: {
          code: "provider_error",
          message: "failed",
          provider: "codex",
          retryable: true,
        },
      }),
    ).toBe(false);
    expect(isStructuredOutputResult({ ok: true, provider: "pi" })).toBe(false);
    expect(isStructuredOutputResult({ ok: true, provider: "unknown", value: {} })).toBe(false);
    expect(isStructuredOutputResult({ ok: true, provider: "pi", value: undefined })).toBe(false);
  });

  test("distinguishes an unavailable Pi read from a provider-authored result", () => {
    const cause = new Error("connection reset");
    const error = new StructuredOutputReadUnavailableError(
      "pi",
      "Pi structured output could not be read",
      { requestId: "pi-request", cause },
    );

    expect(isStructuredOutputReadUnavailableError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "structured_output_read_unavailable",
      provider: "pi",
      requestId: "pi-request",
      retryable: true,
    });
    expect(error.cause).toBe(cause);
    expect(isStructuredOutputResult(error)).toBe(false);
  });

  test("accepts object schemas and rejects non-object JSON values", () => {
    expect(isJsonSchema({ type: "object", properties: {} })).toBe(true);
    for (const value of [null, [], "object", 1, true]) {
      expect(isJsonSchema(value)).toBe(false);
    }
  });
});
