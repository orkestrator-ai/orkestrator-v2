import { describe, expect, test } from "bun:test";
import {
  classifyProviderFailure,
  PROVIDER_FAILURE_REASONS,
  PROVIDER_FAILURE_REMEDIES,
  providerFailurePresentation,
  providerFailureReason,
  providerFailureRetryRequestId,
  supportedProviderFailureRemedies,
  type ProviderFailureReason,
} from "./provider-failures.js";

/**
 * The same problem, worded the way each provider words it. Every row of one
 * reason must classify the same, which is what lets the renderer explain it
 * the same way whichever agent hit it.
 */
const CROSS_PROVIDER_WORDING: Record<ProviderFailureReason, readonly string[]> = {
  authentication: [
    // Claude
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    "Not logged in · Please run /login",
    // Codex
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    // OpenCode
    "Model request failed (HTTP 401): Invalid API key",
    "ProviderAuthError: credentials not found",
    // Cursor / Pi
    "Invalid API key provided",
  ],
  "usage-limit": [
    "You've hit your limit · resets 3pm (Europe/London)",
    "You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM.",
    "Grok request failed: USAGE_EXHAUSTED",
    "Go limit reached",
  ],
  "rate-limit": [
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    "Model request failed (HTTP 429): Too Many Requests",
    "rateLimitExceeded",
  ],
  billing: [
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    "billing_error: update your payment method",
  ],
  "model-unavailable": [
    "API Error: 404 model: claude-x-9 not found",
    "The model `gpt-9` does not exist or you do not have access to it.",
    "Unknown model: foo/bar",
  ],
  "context-exhausted": [
    "prompt is too long: 210000 tokens > 200000 maximum",
    "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying. (contextWindowExceeded)",
    "This model's maximum context length is 128000 tokens.",
    "Context limit reached; compact the conversation",
    "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
  ],
  "provider-unavailable": [
    "API Error: 529 Overloaded",
    "API Error: 500 Internal server error",
    "stream disconnected before completion: error sending request",
    "fetch failed",
    "Model request failed (HTTP 503): Service Unavailable",
  ],
  "turn-failed": ["The tool crashed unexpectedly", "Something odd happened"],
};

describe("classifyProviderFailure", () => {
  for (const reason of PROVIDER_FAILURE_REASONS) {
    test(`${reason} reads the same across providers`, () => {
      for (const text of CROSS_PROVIDER_WORDING[reason]) {
        expect({ text, reason: classifyProviderFailure({ text }).reason }).toEqual({
          text,
          reason,
        });
      }
    });
  }

  test("a structured reason wins over the text", () => {
    expect(classifyProviderFailure({ reason: "context-exhausted", text: "Overloaded" })).toEqual({
      reason: "context-exhausted",
      signal: "provider",
    });
    expect(classifyProviderFailure({ failureKind: "usage-limit", text: "x" })).toEqual({
      reason: "usage-limit",
      signal: "provider",
    });
  });

  test("an unknown structured value falls back to the text", () => {
    expect(classifyProviderFailure({ reason: "nope", text: "fetch failed" })).toEqual({
      reason: "provider-unavailable",
      signal: "text",
    });
    expect(classifyProviderFailure({})).toEqual({ reason: "turn-failed", signal: "none" });
  });

  test("a usage limit keeps the provider's reset words and a verified reset time", () => {
    expect(
      classifyProviderFailure({
        failureKind: "usage-limit",
        text: "You've hit your limit · resets 3pm",
      }),
    ).toEqual({ reason: "usage-limit", signal: "provider", resetHint: "3pm" });
    expect(classifyProviderFailure({ text: "Claude AI usage limit reached|1761840000" })).toEqual({
      reason: "usage-limit",
      signal: "text",
      resetsAt: "2025-10-30T16:00:00.000Z",
    });
    expect(
      classifyProviderFailure({
        reason: "usage-limit",
        resetsAt: "2026-11-19T18:00:00Z",
      }),
    ).toEqual({ reason: "usage-limit", signal: "provider", resetsAt: "2026-11-19T18:00:00.000Z" });
    // A reset time is only ever a usage limit's, and never an invalid one.
    expect(
      classifyProviderFailure({ reason: "rate-limit", resetsAt: "2026-11-19T18:00:00Z" }),
    ).toEqual({ reason: "rate-limit", signal: "provider" });
    expect(classifyProviderFailure({ reason: "usage-limit", resetsAt: "soon" })).toEqual({
      reason: "usage-limit",
      signal: "provider",
    });
  });
});

test("providerFailureReason accepts only known reasons", () => {
  expect(providerFailureReason("billing")).toBe("billing");
  expect(providerFailureReason("Billing")).toBeUndefined();
  expect(providerFailureReason(7)).toBeUndefined();
});

test("every reason has words, and none promises a remedy it does not list", () => {
  for (const reason of PROVIDER_FAILURE_REASONS) {
    const { title, explanation } = providerFailurePresentation(reason, "Codex");
    expect(title.length).toBeGreaterThan(0);
    expect(explanation.length).toBeGreaterThan(0);
  }
  expect(PROVIDER_FAILURE_REMEDIES["usage-limit"]).toEqual([]);
  expect(PROVIDER_FAILURE_REMEDIES.billing).toEqual([]);
});

test("only the remedies a host can perform are offered", () => {
  expect(supportedProviderFailureRemedies("authentication", { retry: true })).toEqual([]);
  expect(supportedProviderFailureRemedies("authentication", { "sign-in": true })).toEqual([
    "sign-in",
  ]);
  expect(
    supportedProviderFailureRemedies("context-exhausted", { retry: true, "change-model": true }),
  ).toEqual(["change-model"]);
  expect(supportedProviderFailureRemedies("usage-limit", { retry: true })).toEqual([]);
  expect(supportedProviderFailureRemedies("turn-failed", { retry: false })).toEqual([]);
});

test("a retry's request id is stable for one failure and distinct across failures", () => {
  const first = providerFailureRetryRequestId("native-terminal:error:abc", "2026-11-19T10:00:00Z");
  expect(first).toBe(
    providerFailureRetryRequestId("native-terminal:error:abc", "2026-11-19T10:00:00Z"),
  );
  expect(first).not.toBe(
    providerFailureRetryRequestId("native-terminal:error:abc", "2026-11-19T11:00:00Z"),
  );
  expect(first).toMatch(/^failure-retry:[0-9a-f]{16}$/);
});
