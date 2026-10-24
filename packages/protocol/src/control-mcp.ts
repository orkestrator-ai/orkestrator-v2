/**
 * Control MCP credentials: profiles, capability presets and the single rule
 * that decides whether a credential may call a public action.
 *
 * A credential names a profile and a capability list. The profile decides
 * which tools the client sees and how results are worded; the capability list
 * decides which public actions it may run. Both the backend (tool filtering,
 * `run_action`, every direct tool) and Settings → MCP read this module, so
 * the rule and the presets cannot drift between the two.
 */

import { PUBLIC_ACTIONS, type PublicActionName } from "./public-api.js";
import {
  PUBLIC_ACTION_INPUTS,
  PUBLIC_CAPABILITIES,
  type PublicCapability,
} from "./public-api-inputs.js";

/**
 * - `voice`: a small spoken-request core plus the gateway; short, speakable
 *   results; risky actions confirmed with a token.
 * - `full`: every tool, including one direct tool per allowed public action.
 * - `read-only`: the same tools as `full`, with every mutation refused.
 * - `custom`: the `full` tool shape over an explicit capability list.
 */
export const CONTROL_MCP_PROFILES = Object.freeze([
  "voice",
  "full",
  "read-only",
  "custom",
] as const);

export type ControlMcpProfile = (typeof CONTROL_MCP_PROFILES)[number];

export function isControlMcpProfile(value: unknown): value is ControlMcpProfile {
  return typeof value === "string" && (CONTROL_MCP_PROFILES as readonly string[]).includes(value);
}

/** `host` updates Orkestrator itself and is never granted to an MCP credential. */
export const CONTROL_MCP_GRANTABLE_CAPABILITIES: readonly PublicCapability[] = Object.freeze(
  PUBLIC_CAPABILITIES.filter((capability) => capability !== "host"),
);

export function isGrantableControlMcpCapability(value: unknown): value is PublicCapability {
  return (
    typeof value === "string" &&
    (CONTROL_MCP_GRANTABLE_CAPABILITIES as readonly string[]).includes(value)
  );
}

/**
 * Default capabilities of each profile. `voice` leaves out project and
 * settings edits, destructive environment actions and `exec`; a voice
 * credential may still be granted `exec` explicitly, and then confirms every
 * call. `custom` has no preset: its list is always explicit.
 */
export const CONTROL_MCP_PROFILE_CAPABILITIES: Readonly<
  Record<ControlMcpProfile, readonly PublicCapability[]>
> = Object.freeze({
  voice: Object.freeze([
    "discovery",
    "sessions.read",
    "sessions.control",
    "interactions",
    "environments.lifecycle",
    "tickets",
    "mail",
  ] as PublicCapability[]),
  full: CONTROL_MCP_GRANTABLE_CAPABILITIES,
  "read-only": CONTROL_MCP_GRANTABLE_CAPABILITIES,
  custom: Object.freeze([] as PublicCapability[]),
});

/** What every rule below needs to know about a credential. */
export interface ControlMcpCredentialPolicy {
  id: string;
  profile: ControlMcpProfile;
  capabilities: readonly PublicCapability[];
  deniedActions: readonly PublicActionName[];
}

/** A credential as Settings → MCP shows it. The token is shown so Copy setup works. */
export interface ControlMcpCredentialSummary extends ControlMcpCredentialPolicy {
  label: string;
  token: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Credential IDs appear in authorities and request keys; keep them small and plain. */
export const CONTROL_MCP_CREDENTIAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * Normalize a requested capability list for a profile. Omitted means the
 * profile's preset; `custom` must name at least one. Unknown or ungrantable
 * capabilities are refused rather than dropped, so a typo never silently
 * produces a weaker or stronger credential than the one asked for.
 */
export function resolveControlMcpCapabilities(
  profile: ControlMcpProfile,
  requested?: readonly unknown[],
): PublicCapability[] {
  if (requested === undefined) {
    if (profile === "custom") throw new Error("A custom credential needs a capability list");
    return [...CONTROL_MCP_PROFILE_CAPABILITIES[profile]];
  }
  const invalid = requested.filter((capability) => !isGrantableControlMcpCapability(capability));
  if (invalid.length > 0) {
    throw new Error(`Capabilities cannot be granted: ${invalid.map(String).join(", ")}`);
  }
  const unique = CONTROL_MCP_GRANTABLE_CAPABILITIES.filter((capability) =>
    requested.includes(capability),
  );
  if (unique.length === 0) throw new Error("A credential needs at least one capability");
  return unique;
}

/**
 * The one authorization rule. Called by `run_action`, by every direct tool,
 * and when filtering `tools/list`, so a tool a credential cannot use is never
 * listed and never runs.
 */
export function controlMcpActionAllowed(
  credential: ControlMcpCredentialPolicy,
  action: PublicActionName,
): boolean {
  const contract = PUBLIC_ACTION_INPUTS[action];
  if (!contract || contract.capability === "host") return false;
  if (credential.deniedActions.includes(action)) return false;
  if (credential.profile === "read-only" && PUBLIC_ACTIONS[action].mutation) return false;
  return credential.capabilities.includes(contract.capability);
}

/**
 * When an MCP call of `action` needs a confirm token under `profile`.
 *
 * - `none`: runs directly.
 * - `always`: every call.
 * - `discard`: only calls with `discard: true`.
 * - `approval`: only calls that approve a command or file change (`answer` or
 *   `approve-for-session` on an interaction that is not a question); the
 *   caller looks the interaction up to decide.
 */
export type ControlMcpConfirmationRule = "none" | "always" | "discard" | "approval";

export function controlMcpConfirmationRule(
  action: PublicActionName,
  profile: ControlMcpProfile,
): ControlMcpConfirmationRule {
  const contract = PUBLIC_ACTION_INPUTS[action];
  if (contract.confirmation === "never") return "none";
  if (contract.confirmation === "voice" && profile !== "voice") return "none";
  return contract.confirmWhen ?? "always";
}

/** Interaction kinds whose `answer` is an answer, not an approval. */
export const CONTROL_MCP_NON_APPROVAL_INTERACTIONS: readonly string[] = Object.freeze(["question"]);

export function isApprovalResolution(interactionKind: string, resolutionAction: unknown): boolean {
  return (
    (resolutionAction === "answer" || resolutionAction === "approve-for-session") &&
    !CONTROL_MCP_NON_APPROVAL_INTERACTIONS.includes(interactionKind)
  );
}

/** How long a confirm token stays valid. */
export const CONTROL_MCP_CONFIRM_TOKEN_TTL_MS = 120_000;

/** Byte budget of the voice profile's serialized `tools/list`. */
export const CONTROL_MCP_VOICE_TOOLS_BUDGET_BYTES = 8_000;

/** Largest text block a voice-profile result carries. */
export const CONTROL_MCP_VOICE_TEXT_MAX_BYTES = 2_048;
