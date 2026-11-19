/**
 * Provider failures: one normalised reason for why a turn failed, whichever
 * provider failed it, with the same explanation and the same set of recovery
 * actions for the same reason.
 *
 * Two signals feed a reason, in this order:
 *
 * 1. A structured code the provider gave, translated at the bridge (Claude's
 *    SDK API error code, Codex app-server's `codexErrorInfo`) and carried as
 *    `failureReason` beside the failed turn's `error` in the session snapshot,
 *    then on the backend's terminal row as `failure.reason`. The usage-limit
 *    `failureKind` counts as one too.
 * 2. The failed turn's error text, for providers without a structured code,
 *    bridges older than the field, and rows recorded before it. The text path
 *    is permanent.
 *
 * Anything neither names is `turn-failed`: an honest "the provider stopped
 * this turn with an error", never a guess.
 *
 * Remedies are the reason's *candidate* actions. A host offers only those it
 * can actually perform ({@link supportedProviderFailureRemedies}), so a
 * failure never shows a button the host cannot honour.
 */

import { classifyUsageLimitError, turnFailureKind } from "./agent-usage-limits.js";

export const PROVIDER_FAILURE_REASONS = [
  "authentication",
  "usage-limit",
  "rate-limit",
  "billing",
  "model-unavailable",
  "context-exhausted",
  "provider-unavailable",
  "turn-failed",
] as const;

export type ProviderFailureReason = (typeof PROVIDER_FAILURE_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(PROVIDER_FAILURE_REASONS);

/** A wire value narrowed to a reason, or undefined for anything else. */
export function providerFailureReason(value: unknown): ProviderFailureReason | undefined {
  return typeof value === "string" && REASON_SET.has(value)
    ? (value as ProviderFailureReason)
    : undefined;
}

/** What a transcript row carries about the failure it reports. */
export interface ProviderFailureDescriptor {
  /** The provider's structured reason, when it gave one. */
  reason?: ProviderFailureReason;
  /**
   * When an exhausted quota window resets, as the provider reported it (an
   * ISO time). Only a provider-reported window time goes here; free text such
   * as "resets 3pm" is never parsed into one.
   */
  resetsAt?: string;
}

/** A recovery action a failure can offer. */
export type ProviderFailureRemedy = "sign-in" | "retry" | "change-model";

/**
 * Each reason's candidate remedies, most useful first. A usage limit or a
 * billing refusal offers no retry: the same request fails again until
 * something outside the conversation changes.
 */
export const PROVIDER_FAILURE_REMEDIES: Readonly<
  Record<ProviderFailureReason, readonly ProviderFailureRemedy[]>
> = {
  authentication: ["sign-in"],
  "usage-limit": [],
  "rate-limit": ["retry"],
  billing: [],
  "model-unavailable": ["change-model"],
  "context-exhausted": ["change-model"],
  "provider-unavailable": ["retry"],
  "turn-failed": ["retry"],
};

/** The reason's remedies that the host can perform, in the reason's order. */
export function supportedProviderFailureRemedies(
  reason: ProviderFailureReason,
  available: Partial<Record<ProviderFailureRemedy, boolean>>,
): ProviderFailureRemedy[] {
  return PROVIDER_FAILURE_REMEDIES[reason].filter((remedy) => available[remedy] === true);
}

export interface ProviderFailureClassification {
  reason: ProviderFailureReason;
  /** `provider`: a structured code said so; `text`: the error text did; `none`: neither. */
  signal: "provider" | "text" | "none";
  /** The provider's own words for when a usage limit lifts, when it gave any. */
  resetHint?: string;
  /**
   * When a usage limit lifts, as an ISO time, only when the provider stated
   * it as a machine-readable time: a quota window it reported (passed in by
   * the host) or Claude's `usage limit reached|<epoch seconds>` reply.
   */
  resetsAt?: string;
}

/** Claude's older refusal carries the reset as epoch seconds: `…limit reached|1761840000`. */
function epochResetFromText(text: string): string | undefined {
  const match = /usage limit reached\|(\d{10})\b/i.exec(text);
  if (!match) return undefined;
  const ms = Number(match[1]) * 1_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function validResetsAt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const AUTHENTICATION_PATTERNS: readonly RegExp[] = [
  /\bfailed to authenticate\b/i,
  /\bauthentication[_ ](?:error|failed|required)\b/i,
  /\binvalid (?:authentication|auth) credentials\b/i,
  /\binvalid[_ ]api[_ ]key\b/i,
  /\b(?:incorrect|missing|expired|revoked) api key\b/i,
  /\bnot (?:logged|signed) in\b/i,
  /\bplease (?:run \/login|log ?in again|sign in again)\b/i,
  /\b(?:oauth )?token (?:has )?(?:expired|been revoked|revoked)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bProviderAuthError\b/,
  /\b(?:api error|http|status(?: code)?)[: ]+401\b/i,
  /\(HTTP 401\)/,
];

const BILLING_PATTERNS: readonly RegExp[] = [
  /\bcredit balance is too low\b/i,
  /\bbilling[_ ](?:error|issue|problem|details)\b/i,
  /\b(?:update|add|check) (?:your )?(?:billing|payment method)\b/i,
  /\baccount (?:is )?on hold\b/i,
];

const CONTEXT_PATTERNS: readonly RegExp[] = [
  /\bcontext[\s_-]?window(?:[\s_-]?(?:exceeded|is full|limit))\b/i,
  /\bcontextWindowExceeded\b/,
  /\bcontext_length_exceeded\b/,
  /\bmaximum context length\b/i,
  /\bprompt is too long\b/i,
  /\b(?:input|conversation|request) (?:is )?too long for (?:the )?(?:model|context)\b/i,
  /\bContextOverflowError\b/,
  /\bexceeds? (?:the )?(?:model'?s? )?context (?:window|length|limit)\b/i,
  /\bcontext (?:window |length )?limit (?:reached|exceeded)\b/i,
  // Codex: "Codex ran out of room in the model's context window."
  /\bout of (?:room|space) in (?:the )?(?:model'?s )?context\b/i,
];

const MODEL_PATTERNS: readonly RegExp[] = [
  /\bmodelNotFound\b|\bmodel_not_found\b/,
  /\bmodel\b(?! request)[^\n.]{0,60}\b(?:not found|does not exist|is not available|not available|unavailable|not supported|is not supported|no longer (?:available|supported))\b/i,
  /\b(?:unknown|invalid|unsupported) model\b/i,
  /\bno such model\b/i,
  /\bModelNotFoundError\b/,
];

const RATE_PATTERNS: readonly RegExp[] = [
  /\brate[\s_-]?limit(?:ed|s)?\b/i,
  /\brateLimitExceeded\b/,
  /\btoo many requests\b/i,
  /\b(?:api error|http|status(?: code)?)[: ]+429\b/i,
  /\(HTTP 429\)/,
];

const UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /\boverloaded(?:_error)?\b/i,
  /\bserverOverloaded\b/,
  /\binternal server error\b/i,
  /\bservice (?:is )?(?:temporarily )?unavailable\b/i,
  /\bbad gateway\b|\bgateway time-?out\b/i,
  /\b(?:api error|http|status(?: code)?)[: ]+5\d\d\b/i,
  /\(HTTP 5\d\d\)/,
  /\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEAI_AGAIN\b/,
  /\bfetch failed\b|\bnetwork error\b|\bsocket hang up\b/i,
  /\b(?:connection|stream) (?:was )?(?:reset|refused|closed|dropped|disconnected|failed|error)\b/i,
  /\bstream disconnected\b/i,
];

/**
 * Text classification, most specific first. A usage limit is checked before
 * a rate limit because Claude's and Codex's plan refusals mention "limit" in
 * ways the rate-limit wording also matches; the usage-limit match is the one
 * the account auto-switch already acts on, so both must agree.
 */
function classifyText(text: string): ProviderFailureClassification | null {
  const usage = classifyUsageLimitError(text);
  if (AUTHENTICATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return { reason: "authentication", signal: "text" };
  }
  if (BILLING_PATTERNS.some((pattern) => pattern.test(text))) {
    return { reason: "billing", signal: "text" };
  }
  if (usage) return { reason: "usage-limit", signal: "text", ...usage };
  if (CONTEXT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { reason: "context-exhausted", signal: "text" };
  }
  if (MODEL_PATTERNS.some((pattern) => pattern.test(text))) {
    return { reason: "model-unavailable", signal: "text" };
  }
  if (RATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { reason: "rate-limit", signal: "text" };
  }
  if (UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { reason: "provider-unavailable", signal: "text" };
  }
  return null;
}

/**
 * The normalised reason a turn failed. A structured reason wins over the
 * text; the text's reset hint is still kept for a usage limit, because only
 * the text carries the provider's own words for when it lifts.
 */
export function classifyProviderFailure(input: {
  reason?: unknown;
  failureKind?: unknown;
  text?: unknown;
  /** A provider-reported reset time for an exhausted quota window. */
  resetsAt?: unknown;
}): ProviderFailureClassification {
  const text = typeof input.text === "string" ? input.text.slice(0, 4_000) : "";
  const structured =
    providerFailureReason(input.reason) ??
    (turnFailureKind(input.failureKind) ? ("usage-limit" as const) : undefined);
  const classified: ProviderFailureClassification = structured
    ? { reason: structured, signal: "provider" }
    : (text.trim() && classifyText(text)) || { reason: "turn-failed", signal: "none" };
  if (classified.reason !== "usage-limit") return classified;
  const hint = classified.resetHint ?? classifyUsageLimitError(text)?.resetHint;
  const resetsAt = validResetsAt(input.resetsAt) ?? epochResetFromText(text);
  return {
    reason: classified.reason,
    signal: classified.signal,
    ...(hint ? { resetHint: hint } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

export interface ProviderFailurePresentation {
  title: string;
  explanation: string;
}

/**
 * The words a reader sees for a reason. One table for every provider: the
 * same problem reads the same whichever agent hit it. `agentLabel` names the
 * provider ("Claude", "Codex"); explanations never promise an action, since
 * which actions appear depends on the host.
 */
export function providerFailurePresentation(
  reason: ProviderFailureReason,
  agentLabel = "The agent",
): ProviderFailurePresentation {
  switch (reason) {
    case "authentication":
      return {
        title: "Sign-in needed",
        explanation: `${agentLabel} refused this turn because its sign-in or API key is missing, expired or invalid. Sign in again, then send the turn again.`,
      };
    case "usage-limit":
      return {
        title: "Usage limit reached",
        explanation:
          "This account's plan allowance is used up. A new turn can run once the limit resets or the session moves to another account.",
      };
    case "rate-limit":
      return {
        title: "Rate limited",
        explanation: `${agentLabel} is receiving too many requests from this account right now. This is usually brief; wait a moment, then try again.`,
      };
    case "billing":
      return {
        title: "Billing problem",
        explanation:
          "The provider refused this turn because of the account's billing or credit balance. Check the account's billing with the provider, then send the turn again.",
      };
    case "model-unavailable":
      return {
        title: "Model unavailable",
        explanation:
          "The selected model does not exist or is not available to this account. Choose another model, then send the turn again.",
      };
    case "context-exhausted":
      return {
        title: "Conversation too long",
        explanation:
          "The conversation no longer fits in the model's context window. Compact it, start a new conversation, or choose a model with a larger window.",
      };
    case "provider-unavailable":
      return {
        title: "Provider unavailable",
        explanation: `${agentLabel}'s service could not be reached or is overloaded. This is usually temporary; try again in a moment.`,
      };
    case "turn-failed":
      return {
        title: "Turn failed",
        explanation: `${agentLabel} stopped this turn with an error. Its own message is in the details.`,
      };
  }
}

/**
 * The prompt a Retry action sends. The failed turn is already in the
 * conversation, so a retry asks the agent to carry on rather than repeating
 * the user's words, the same shape the usage-limit resend uses.
 */
export const PROVIDER_FAILURE_RETRY_PROMPT =
  "The previous turn ended with an error. Please try again: continue the request from where it stopped, without repeating work or tool calls that already completed.";

/**
 * The request id a Retry action dispatches under, derived from the failure it
 * answers. Pressing Retry twice, or on two mounted views of the same failure,
 * reaches the backend's dispatch journal with one id and runs one turn.
 * `occurredAt` keeps two failures with the same text apart.
 */
export function providerFailureRetryRequestId(failureId: string, occurredAt: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${failureId}\u0000${occurredAt}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let second = 0x01000193;
  for (const char of `${occurredAt}\u0000${failureId}`) {
    second ^= char.codePointAt(0)!;
    second = Math.imul(second, 0x811c9dc5) >>> 0;
  }
  return `failure-retry:${hash.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}
