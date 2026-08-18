import { afterEach, describe, expect, mock, test } from "bun:test";

import { formatOpenCodeError, isOpenCodeMessageAbortedError } from "./opencode-client";

const originalFetch = globalThis.fetch;

function setTestUrl(url: string): void {
  (window as unknown as Window & { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete window.orkestratorGateway;
  setTestUrl("about:blank");
  mock.restore();
});

describe("opencode-client formatOpenCodeError", () => {
  test("redacts sensitive values from raw error details", () => {
    const errorText = formatOpenCodeError({
      name: "APIError",
      data: {
        message: "Unauthorized",
        status: 401,
        requestID: "req_redact_1",
        authorization: "Bearer top-secret-token",
        apiKey: "sk-secret-key",
        nested: {
          refresh_token: "refresh-secret",
          safeField: "safe-value",
        },
        attempts: ["Bearer array-secret", { accessToken: "nested-array-secret" }],
      },
    });

    expect(errorText).toContain("Unauthorized");
    expect(errorText).toContain("Status: 401");
    expect(errorText).toContain("Request ID: req_redact_1");
    expect(errorText).toContain('"authorization": "[REDACTED]"');
    expect(errorText).toContain('"apiKey": "[REDACTED]"');
    expect(errorText).toContain('"refresh_token": "[REDACTED]"');
    expect(errorText).toContain('"accessToken": "[REDACTED]"');
    expect(errorText).toContain("Bearer [REDACTED]");
    expect(errorText).toContain('"safeField": "safe-value"');
    expect(errorText).not.toContain("top-secret-token");
    expect(errorText).not.toContain("sk-secret-key");
    expect(errorText).not.toContain("refresh-secret");
    expect(errorText).not.toContain("array-secret");
    expect(errorText).not.toContain("nested-array-secret");
  });

  test("formats primitive, Error, and headline-only fallbacks", () => {
    expect(formatOpenCodeError("Bearer private-value")).toBe("Bearer [REDACTED]");
    expect(formatOpenCodeError(null)).toBe("An unknown error occurred");
    expect(formatOpenCodeError(new Error("offline"))).toContain("offline");
    expect(formatOpenCodeError({ data: { type: "TimeoutError" } })).toContain("TimeoutError");
    expect(
      formatOpenCodeError({
        data: { errorType: "RateLimit", message: "Try later" },
      }),
    ).toStartWith("RateLimit: Try later");
  });

  test("handles circular details and truncates oversized raw errors", () => {
    const circular: Record<string, unknown> = { message: "circular failure" };
    circular.self = circular;
    const circularText = formatOpenCodeError(circular);
    expect(circularText).toContain("circular failure");
    expect(circularText).toContain("[Circular]");

    const oversized = formatOpenCodeError({
      message: "large failure",
      detailBlob: "x".repeat(5_000),
    });
    expect(oversized).toContain("... (details truncated)");
    expect(oversized.length).toBeLessThan(4_200);
  });

  test("keeps the headline when raw error serialization fails", () => {
    const unserializable: Record<string, unknown> = { message: "serialization failed" };
    Object.defineProperty(unserializable, "details", {
      enumerable: true,
      get() {
        throw new Error("getter must not escape");
      },
    });

    expect(formatOpenCodeError(unserializable)).toBe("serialization failed");
  });

  test("emits the code detail line and does not repeat an error type already in the summary", () => {
    const withCode = formatOpenCodeError({
      data: { message: "Quota exhausted", code: "insufficient_quota", status: 429 },
      name: "RateLimitError",
    });
    expect(withCode).toStartWith("RateLimitError: Quota exhausted");
    expect(withCode).toContain("Code: insufficient_quota");
    expect(withCode).toContain("Status: 429");

    // The type is already spelled out in the summary, so prefixing it again
    // would render "TimeoutError: TimeoutError: ...".
    const deduped = formatOpenCodeError({
      name: "TimeoutError",
      data: { message: "TimeoutError while contacting the provider" },
    });
    expect(deduped).toStartWith("TimeoutError while contacting the provider");
    expect(deduped).not.toContain("TimeoutError: TimeoutError");
  });
});

describe("opencode-client isOpenCodeMessageAbortedError", () => {
  test("recognizes only the SDK's intentional-abort discriminator", () => {
    expect(
      isOpenCodeMessageAbortedError({
        name: "MessageAbortedError",
        data: { message: "Aborted" },
      }),
    ).toBe(true);
    expect(
      isOpenCodeMessageAbortedError({
        name: "UnknownError",
        data: { message: "MessageAbortedError" },
      }),
    ).toBe(false);
    expect(isOpenCodeMessageAbortedError("MessageAbortedError: Aborted")).toBe(false);
    expect(isOpenCodeMessageAbortedError(null)).toBe(false);
    expect(isOpenCodeMessageAbortedError(undefined)).toBe(false);
  });

  test("matches an Error instance carrying the discriminator on its prototype", () => {
    // The SDK's error interceptor wraps some failures into real Errors, so the
    // name is not always an own property of a plain object.
    class MessageAbortedError extends Error {
      override readonly name = "MessageAbortedError";
    }
    expect(isOpenCodeMessageAbortedError(new MessageAbortedError("Aborted"))).toBe(true);

    const tagged = new Error("Aborted");
    tagged.name = "MessageAbortedError";
    expect(isOpenCodeMessageAbortedError(tagged)).toBe(true);

    expect(isOpenCodeMessageAbortedError(new Error("MessageAbortedError"))).toBe(false);
  });

  test("does not match a nested or differently-cased discriminator", () => {
    // Only the top-level `name` is the SDK's NamedError discriminator; a nested
    // copy is a real failure whose payload happens to mention the abort.
    expect(
      isOpenCodeMessageAbortedError({
        name: "ProviderError",
        data: { name: "MessageAbortedError" },
      }),
    ).toBe(false);
    expect(isOpenCodeMessageAbortedError({ name: "messageabortederror" })).toBe(false);
    expect(isOpenCodeMessageAbortedError({ data: { message: "Aborted" } })).toBe(false);
    expect(isOpenCodeMessageAbortedError([])).toBe(false);
  });
});
