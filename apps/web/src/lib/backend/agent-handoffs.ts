import { asWebModel, nativeSessions } from "@/lib/node-scope/domains/native-sessions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { PersistedAgentHandoff } from "@/types";
import { commandBackendClient, type BackendClient } from "./client";

// --- Agent Handoffs ("Continue in…") ---

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

/** What this backend does with handoffs on its own. */
export interface AgentHandoffCapabilities {
  /** `create_agent_handoff` builds handoffs from the authoritative transcript. */
  create: boolean;
  /** The first dispatch to a destination tab carries its pending handoff. */
  delivery: boolean;
  /** Unreferenced handoffs are pruned by the backend. */
  pruning: boolean;
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createAgentHandoffsApi(client: BackendClient) {
  const native = () => nativeSessions(client);

  async function getAgentHandoff<T = unknown>(
    handoffId: string,
  ): Promise<PersistedAgentHandoff<T> | null> {
    return asWebModel<PersistedAgentHandoff<T> | null>(native().get_agent_handoff({ handoffId }));
  }

  /**
   * Builds and stores a handoff on the backend from the source session's full
   * transcript, with change summaries measured there. Refused with "Unknown
   * backend command" by a backend that predates it.
   */
  async function createAgentHandoff(
    input: CreateAgentHandoffInput,
  ): Promise<PersistedAgentHandoff> {
    return asWebModel<PersistedAgentHandoff>(native().create_agent_handoff({ ...input }));
  }

  /**
   * The backend's handoff capabilities: folded into `native-sessions`, so every
   * supported node builds, delivers and prunes handoffs and nothing is asked.
   */
  async function getAgentHandoffCapabilities(): Promise<AgentHandoffCapabilities> {
    return native().handoffCapabilities();
  }

  /**
   * Whether this tab's refused Claude prompt goes out again after a sign-in. A
   * backend that predates the command answers "Unknown backend command", which the
   * caller reads as "no".
   */
  async function getNativeAgentSignInResend(input: {
    environmentId: string;
    agent: AgentPlatform;
    logicalSessionKey: string;
  }): Promise<{ pending: boolean }> {
    return native().get_native_agent_sign_in_resend(input);
  }

  return {
    getAgentHandoff,
    createAgentHandoff,
    getAgentHandoffCapabilities,
    getNativeAgentSignInResend,
  };
}

export type AgentHandoffsApi = ReturnType<typeof createAgentHandoffsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getAgentHandoff,
  createAgentHandoff,
  getAgentHandoffCapabilities,
  getNativeAgentSignInResend,
} = createAgentHandoffsApi(commandBackendClient);
