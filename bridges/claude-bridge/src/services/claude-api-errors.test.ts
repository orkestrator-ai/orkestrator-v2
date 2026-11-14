import { describe, expect, test } from "bun:test";
import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import { projectEssentialRecord } from "@orkestrator/protocol/log-essential";
import { claudeApiErrorCode, providerStateApiError } from "./claude-api-errors.js";

/** Every code the pinned SDK names: `satisfies` fails the typecheck on one missing. */
const SDK_CODES = Object.keys({
  authentication_failed: true,
  oauth_org_not_allowed: true,
  account_on_hold: true,
  verification_required: true,
  billing_error: true,
  rate_limit: true,
  overloaded: true,
  invalid_request: true,
  model_not_found: true,
  server_error: true,
  unknown: true,
  max_output_tokens: true,
  cloud_credential_error: true,
} satisfies Record<SDKAssistantMessageError, true>);

describe("Claude API error fates", () => {
  test("the account's and the service's states are provider refusals", () => {
    for (const code of [
      "authentication_failed",
      "oauth_org_not_allowed",
      "account_on_hold",
      "verification_required",
      "billing_error",
      "rate_limit",
      "overloaded",
      "server_error",
      "cloud_credential_error",
    ] as const) {
      expect(providerStateApiError(code)).toBe(code);
    }
  });

  test("a request the bridge built, or an unexplained failure, stays a failure", () => {
    for (const code of [
      "invalid_request",
      "model_not_found",
      "max_output_tokens",
      "unknown",
    ] as const) {
      expect(providerStateApiError(code)).toBeUndefined();
    }
    expect(providerStateApiError(undefined)).toBeUndefined();
  });

  test("only a code the SDK names is read", () => {
    expect(claudeApiErrorCode("server_error")).toBe("server_error");
    expect(claudeApiErrorCode("toString")).toBeUndefined();
    expect(claudeApiErrorCode("Failed to authenticate")).toBeUndefined();
    expect(claudeApiErrorCode(undefined)).toBeUndefined();
    expect(claudeApiErrorCode(403)).toBeUndefined();
  });

  test("the essential log keeps every code and subtype query.failed can carry", () => {
    for (const code of SDK_CODES) {
      expect(claudeApiErrorCode(code)).toBe(code);
      const projected = projectEssentialRecord(
        {
          orklog: 1,
          ts: "2026-11-13T10:15:11.355Z",
          level: "error",
          area: "bridge.claude",
          event: "query.failed",
          fields: {
            subtype: "success",
            isError: true,
            reason: code,
            apiStatus: 400,
            startupFailure: false,
            sessionId: "session-client-41e14f6d1cf34347b31f3bc1996d9aa2",
          },
        },
        "2026-11-13T10:15:11.355Z",
      );
      expect(projected?.fields).toEqual({
        subtype: "success",
        isError: true,
        reason: code,
        apiStatus: 400,
        startupFailure: false,
      });
    }
  });
});
