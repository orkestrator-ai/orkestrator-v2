import type { BackendId } from "@orkestrator/protocol/federation";
import { create } from "zustand";

/**
 * A pending "open the Merge PR dialog" request from an environment's row menu.
 *
 * The row selects the environment and records the request; the action bar,
 * which owns the merge dialog and its handler, opens the dialog for it, so the
 * menu item behaves exactly like the action bar's Merge PR button. The action
 * bar drops a request it cannot honour (another environment selected, or the
 * PR not mergeable now), so a stale request never opens a dialog later.
 *
 * Renderer-only view state: it carries a node and environment ID and nothing
 * else. The action bar honours only a request for its own node.
 */
export interface MergePrRequest {
  nodeId: BackendId;
  environmentId: string;
  /** Distinguishes repeated requests for the same environment. */
  nonce: number;
}

interface MergePrRequestState {
  request: MergePrRequest | null;
  requestMergePr: (nodeId: BackendId, environmentId: string) => void;
  /** Clears the request, but only the one named, so a newer request survives. */
  clearMergePrRequest: (nonce: number) => void;
}

let nextNonce = 1;

export const useMergePrRequestStore = create<MergePrRequestState>((set) => ({
  request: null,
  requestMergePr: (nodeId, environmentId) =>
    set({ request: { nodeId, environmentId, nonce: nextNonce++ } }),
  clearMergePrRequest: (nonce) =>
    set((state) => (state.request?.nonce === nonce ? { request: null } : state)),
}));
