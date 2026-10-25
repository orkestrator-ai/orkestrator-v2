import { FALLBACK_MACHINE_COLOR } from "@orkestrator/protocol/backend-profile";
import type { BackendId } from "@orkestrator/protocol/federation";
import { workspaceTarget } from "@/lib/portal/portal-transport";
import { useFederation } from "./FederationProvider";

export interface CommandNodeIdentity {
  nodeId: BackendId | null;
  name: string;
  colorToken: string;
  /** The window's workspace is on this node (not on one of its leaves). */
  workspaceHere: boolean;
}

/**
 * The command node this client is connected to. It changes only when the
 * user switches it (the machines menu or Machines settings) or opens another
 * window; opening an environment on another machine moves the window's
 * workspace, never its command node.
 */
export function useCommandNode(): CommandNodeIdentity | null {
  const { portalState, bound } = useFederation();
  const target = workspaceTarget();
  if (!target) {
    if (!bound) return null;
    return {
      nodeId: bound.backendId,
      name: bound.name,
      colorToken: bound.colorToken,
      workspaceHere: true,
    };
  }
  const self = portalState.self;
  return {
    nodeId: portalState.selfId,
    name: self?.displayName ?? "Command node",
    colorToken: self?.colorToken ?? FALLBACK_MACHINE_COLOR,
    workspaceHere: false,
  };
}
