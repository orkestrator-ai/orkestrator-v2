import { invoke } from "@/lib/native/backend";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { PersistedAgentHandoff } from "@/types";

// --- Agent Handoffs ("Continue in…") ---

export async function getAgentHandoff<T = unknown>(
  handoffId: string,
): Promise<PersistedAgentHandoff<T> | null> {
  return invoke<PersistedAgentHandoff<T> | null>("get_agent_handoff", { handoffId });
}

export interface CreateAgentHandoffInput {
  /** Client-minted id; a retry with the same id returns the committed record. */
  handoffId: string;
  environmentId: string;
  /** The source tab's session. */
  sourceAgent: AgentPlatform;
  logicalSessionKey: string;
  /** The provider session the user is looking at; the backend refuses any other. */
  sourceSessionId: string;
  destinationProvider: AgentPlatform;
  /** The handoff the source tab itself was continued from, for a chained transfer. */
  priorHandoffId?: string;
  sourceTitle?: string;
  sourceModel?: string;
}

/**
 * Builds and stores a handoff on the backend from the source session's full
 * transcript, with change summaries measured there. Refused with "Unknown
 * backend command" by a backend that predates it.
 */
export async function createAgentHandoff(
  input: CreateAgentHandoffInput,
): Promise<PersistedAgentHandoff> {
  return invoke<PersistedAgentHandoff>("create_agent_handoff", { ...input });
}

/** What this backend does with handoffs on its own. */
export interface AgentHandoffCapabilities {
  /** `create_agent_handoff` builds handoffs from the authoritative transcript. */
  create: boolean;
  /** The first dispatch to a destination tab carries its pending handoff. */
  delivery: boolean;
  /** Unreferenced handoffs are pruned by the backend. */
  pruning: boolean;
}

const LEGACY_CAPABILITIES: AgentHandoffCapabilities = {
  create: false,
  delivery: false,
  pruning: false,
};

/**
 * The backend's handoff capabilities. A backend that predates the command
 * answers "Unknown backend command": it builds, delivers and prunes nothing,
 * so the renderer keeps doing the delivery and pruning it always did.
 * Any other failure is rethrown; guessing "legacy" on a transient error would
 * prepend history the backend also prepends.
 */
export async function getAgentHandoffCapabilities(): Promise<AgentHandoffCapabilities> {
  try {
    const response = await invoke<unknown>("get_agent_handoff_capabilities");
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Invalid agent handoff capabilities response");
    }
    const candidate = response as Record<string, unknown>;
    return {
      create: candidate.create === true,
      delivery: candidate.delivery === true,
      pruning: candidate.pruning === true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unknown backend command")) return LEGACY_CAPABILITIES;
    throw error;
  }
}

/**
 * Whether this tab's refused Claude prompt goes out again after a sign-in. A
 * backend that predates the command answers "Unknown backend command", which the
 * caller reads as "no".
 */
export async function getNativeAgentSignInResend(input: {
  environmentId: string;
  agent: AgentPlatform;
  logicalSessionKey: string;
}): Promise<{ pending: boolean }> {
  return invoke<{ pending: boolean }>("get_native_agent_sign_in_resend", input);
}

/**
 * Deletes every stored handoff for an environment that the restored pane layout
 * no longer references. Used only against a backend without `pruning`, which
 * otherwise reclaims them itself.
 */
export async function pruneAgentHandoffs(
  environmentId: string,
  referencedHandoffIds: string[],
): Promise<string[]> {
  return invoke<string[]>("prune_agent_handoffs", {
    environmentId,
    referencedHandoffIds,
  });
}
