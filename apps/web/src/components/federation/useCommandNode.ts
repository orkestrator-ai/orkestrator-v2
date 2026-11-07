import type { BackendId } from "@orkestrator/protocol/federation";
import { useFederation } from "./FederationProvider";

export interface CommandNodeIdentity {
  nodeId: BackendId | null;
  name: string;
  colorToken: string;
}

/**
 * The command node this client is connected to. It changes only when the
 * user switches it (the machines menu or Machines settings) or opens another
 * window; opening an environment on another machine shows that machine's
 * workspace in the window, never changes its command node.
 */
export function useCommandNode(): CommandNodeIdentity | null {
  const { bound } = useFederation();
  if (!bound) return null;
  return { nodeId: bound.backendId, name: bound.name, colorToken: bound.colorToken };
}
