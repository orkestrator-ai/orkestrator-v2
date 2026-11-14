/**
 * The card Orkestrator shows for a Codex managed-network approval (to-do 0723
 * task 7), as the backend projected it from the pinned Codex 0.167.0 on a
 * disposable host whose `/etc/codex/requirements.toml` turns the network
 * proxy on.
 *
 * `apps/backend/tests/codex-managed-network-card-live.test.ts` compares the
 * live projection with this presentation, and
 * `NativeAgentInteractionCard.test.tsx` renders it with the real card, so the
 * buttons that test asserts are the ones the live request gets.
 */
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionPresentation,
  type AgentInteractionRequest,
} from "../agent-interactions";

/** Resolved to loopback on the disposable host; never a real name. */
export const CODEX_MANAGED_NETWORK_PROBE_HOST = "probe-host.example.test";

export const CODEX_MANAGED_NETWORK_CARD_PRESENTATION: AgentInteractionPresentation = {
  title: "Approve network access",
  body: `Reason: Network access to ${CODEX_MANAGED_NETWORK_PROBE_HOST} requires approval\nNetwork host: ${CODEX_MANAGED_NETWORK_PROBE_HOST}`,
  questions: [],
  confirmLabel: "Approve",
  declineLabel: "Deny",
  confirmDisabled: false,
  approveForSessionLabel: "Approve for session",
  ruleOffer: {
    kind: "network-host",
    patterns: [CODEX_MANAGED_NETWORK_PROBE_HOST],
    suggested: 0,
  },
};

/** The whole pending request, with fixed identity and timing. */
export function codexManagedNetworkCard(now = Date.now()): AgentInteractionRequest {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    id: "codex:approval:session-network-card:apr-1-1",
    provider: "codex",
    kind: "command-approval",
    origin: "interactive-native",
    sessionId: "session-network-card",
    state: "pending",
    revision: 2,
    presentation: structuredClone(CODEX_MANAGED_NETWORK_CARD_PRESENTATION),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 300_000,
    hold: { available: true },
  };
}
