import { describe, expect, test } from "bun:test";
import {
  formatAcpProviderError,
  formatAcpRpcError,
  GROK_USAGE_EXHAUSTED_MESSAGE,
  MAX_ACP_ERROR_BYTES,
} from "./acp-errors.js";

describe("ACP provider errors", () => {
  const exhausted = {
    message: "API error (status 402 Payment Required): Grok Build usage balance exhausted",
    http_status: 402,
    promptUsage: { inputTokens: 1_081_795, outputTokens: 4_052 },
  };

  test("replaces Grok's generic JSON-RPC wrapper with an actionable credit error", () => {
    expect(formatAcpRpcError({ message: "Internal error", data: exhausted }, "grok")).toBe(
      GROK_USAGE_EXHAUSTED_MESSAGE,
    );
  });

  test("extracts the same cause from Grok's failed sub-agent serialization", () => {
    expect(
      formatAcpProviderError(
        `Session error: Internal error: ${JSON.stringify(exhausted)}`,
        "Sub-agent failed",
        "grok",
      ),
    ).toBe(GROK_USAGE_EXHAUSTED_MESSAGE);
  });

  test("extracts an allowlisted detail from embedded JSON with trailing text", () => {
    expect(
      formatAcpProviderError(
        'Session failed: {"message":"The selected model is unavailable","prompt":"private"} trailing metadata',
        "Sub-agent failed",
      ),
    ).toBe("The selected model is unavailable");
  });

  test("falls back for opaque or malformed lifecycle payloads", () => {
    const fallback = "Sub-agent failed";
    expect(formatAcpProviderError(undefined, fallback)).toBe(fallback);
    expect(formatAcpProviderError(null, fallback)).toBe(fallback);
    expect(formatAcpProviderError("provider stopped unexpectedly", fallback)).toBe(fallback);
    expect(
      formatAcpProviderError('{"prompt":"private prompt","usage":{"tokens":42}}', fallback),
    ).toBe(fallback);
    expect(
      formatAcpProviderError(
        'Session failed: {"message":"safe","prompt":"private prompt"',
        fallback,
      ),
    ).toBe(fallback);
    expect(
      formatAcpProviderError({ prompt: "private prompt", usage: { tokens: 42 } }, fallback),
    ).toBe(fallback);
  });

  test("keeps specific provider failures and does not dump unrelated error data", () => {
    expect(
      formatAcpRpcError({
        message: "Internal error",
        data: { message: "The selected model is unavailable", prompt: "private prompt" },
      }),
    ).toBe("The selected model is unavailable");
    expect(formatAcpRpcError({ message: "fake configuration failure" })).toBe(
      "fake configuration failure",
    );
    expect(
      formatAcpRpcError(
        {
          message: "Internal error",
          data: { message: "API error (status 402 Payment Required): usage balance exhausted" },
        },
        "cursor",
      ),
    ).toBe("Cursor Agent usage balance is exhausted. Add usage credits, then retry this message.");
  });

  test("keeps allowlisted non-billing provider details", () => {
    expect(
      formatAcpProviderError({ detail: "The selected model is unavailable" }, "Sub-agent failed"),
    ).toBe("The selected model is unavailable");
  });

  test("preserves paragraph boundaries while normalizing controls and horizontal space", () => {
    expect(
      formatAcpRpcError({
        message: " RetriableError:\t[unavailable]\u0000 PING timed out\n \nLater response ",
      }),
    ).toBe("RetriableError: [unavailable] PING timed out\n\nLater response");
  });

  test("bounds Unicode errors by UTF-8 bytes without splitting a surrogate pair", () => {
    const formatted = formatAcpRpcError({ message: "😀".repeat(MAX_ACP_ERROR_BYTES) });

    expect(Buffer.byteLength(formatted)).toBeLessThanOrEqual(MAX_ACP_ERROR_BYTES);
    expect(formatted.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(formatted)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(formatted)).toBe(false);
  });
});
