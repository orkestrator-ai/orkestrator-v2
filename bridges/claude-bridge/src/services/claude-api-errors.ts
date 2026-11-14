import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";

/**
 * What a turn that ended on an API error says about the bridge.
 *
 * When a model request fails, Claude Code answers the turn with a synthetic
 * assistant message carrying one of these codes ("Failed to authenticate. API
 * Error: 403 …", "API Error: 500 …") and then an error result. Some codes are
 * the account's or the service's state: a login that expired or an edge that
 * refused the connection, a plan on hold, an overloaded or failing API. The
 * session reports the error text and the user acts on it; nothing in the bridge
 * went wrong, so the turn logs it as a warning under its own event and
 * `query.failed` stays a signal of something actually broken.
 *
 * The rest describe the request this bridge built (an invalid request, an
 * unknown model, an output budget) or say nothing (`unknown`), and stay errors.
 *
 * A `Record` over the SDK's own union, so an SDK bump that adds a code fails
 * the typecheck until someone decides which it is.
 */
const CLAUDE_API_ERROR_FATES: Readonly<
  Record<SDKAssistantMessageError, "provider-state" | "failure">
> = {
  authentication_failed: "provider-state",
  oauth_org_not_allowed: "provider-state",
  account_on_hold: "provider-state",
  verification_required: "provider-state",
  billing_error: "provider-state",
  rate_limit: "provider-state",
  overloaded: "provider-state",
  server_error: "provider-state",
  cloud_credential_error: "provider-state",
  invalid_request: "failure",
  model_not_found: "failure",
  max_output_tokens: "failure",
  unknown: "failure",
};

/** The SDK's API error code, or undefined for anything it does not name. */
export function claudeApiErrorCode(value: unknown): SDKAssistantMessageError | undefined {
  return typeof value === "string" && Object.hasOwn(CLAUDE_API_ERROR_FATES, value)
    ? (value as SDKAssistantMessageError)
    : undefined;
}

/**
 * The code a failed turn's API error names when it is the account's or the
 * service's state rather than a bridge failure, else undefined.
 *
 * Read only from the SDK's structured code. `api_error_status` alone is not
 * enough: a 4xx can be a request this bridge built wrongly, and the status of
 * one that is not carries no code to tell them apart.
 */
export function providerStateApiError(
  code: SDKAssistantMessageError | undefined,
): SDKAssistantMessageError | undefined {
  return code && CLAUDE_API_ERROR_FATES[code] === "provider-state" ? code : undefined;
}
