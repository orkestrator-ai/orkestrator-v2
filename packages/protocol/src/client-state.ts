/**
 * Which formerly browser-local state the connected backend owns.
 *
 * A client probes `get_client_state_capabilities` once per connection. A
 * backend that predates a capability (or the command) keeps that client on
 * its previous, browser-local behaviour; a backend that has it receives the
 * browser's saved copy once (migration) and is the only source afterwards.
 * Browser-safe.
 */

export const CLIENT_STATE_CAPABILITIES_COMMAND = "get_client_state_capabilities";

export interface ClientStateCapabilities {
  /** Coordinator tab groups per project (`get/save_coordinator_pane_layout`). */
  coordinatorPaneLayouts: boolean;
  /** "Merge upstream first?" decision and declines (`check/decline_coordinator_upstream_merge`). */
  coordinatorUpstreamMerge: boolean;
  /** Notice dismissals (`list/dismiss/reconcile_notice_dismissals`). */
  noticeDismissals: boolean;
  /** `environment-attention` events (`@orkestrator/protocol/environment-attention`). */
  environmentAttention: boolean;
}

export const NO_CLIENT_STATE_CAPABILITIES: Readonly<ClientStateCapabilities> = Object.freeze({
  coordinatorPaneLayouts: false,
  coordinatorUpstreamMerge: false,
  noticeDismissals: false,
  environmentAttention: false,
});

export function parseClientStateCapabilities(value: unknown): ClientStateCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...NO_CLIENT_STATE_CAPABILITIES };
  }
  const record = value as Record<string, unknown>;
  return {
    coordinatorPaneLayouts: record.coordinatorPaneLayouts === true,
    coordinatorUpstreamMerge: record.coordinatorUpstreamMerge === true,
    noticeDismissals: record.noticeDismissals === true,
    environmentAttention: record.environmentAttention === true,
  };
}
