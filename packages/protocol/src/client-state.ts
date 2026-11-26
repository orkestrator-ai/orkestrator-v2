/**
 * Which formerly browser-local state the connected backend owns. Part of the
 * `config` domain's version: the domain client answers it without asking
 * (`CONFIG_CLIENT_STATE_CAPABILITIES`). A backend that owns a piece receives
 * the browser's saved copy once (migration) and is the only source
 * afterwards. Browser-safe.
 */

export interface ClientStateCapabilities {
  /** Coordinator tab groups per project (`get/save_coordinator_pane_layout`). */
  coordinatorPaneLayouts: boolean;
  /** "Merge upstream first?" decision and declines (`check/decline_coordinator_upstream_merge`). */
  coordinatorUpstreamMerge: boolean;
  /** The retired "always merge" setting; always `false`. */
  coordinatorUpstreamAutoMerge: boolean;
  /** Notice dismissals (`list/dismiss/reconcile_notice_dismissals`). */
  noticeDismissals: boolean;
  /** `environment-attention` events (`@orkestrator/protocol/environment-attention`). */
  environmentAttention: boolean;
}
