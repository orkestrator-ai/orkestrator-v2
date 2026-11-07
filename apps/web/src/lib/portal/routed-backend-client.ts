/**
 * A `lib/backend` factory client for another node, routed through the command
 * node (`PortalStore.invokeOnNode`). Multi-machine views (`lib/federation`)
 * reach other nodes only through the portal, so their domain clients
 * (`domainApi(routedBackendClient(portal, nodeId), def)`) are built over this.
 * A routed call carries no negotiated range, so the domain client uses the
 * legacy adapter (today's command and arguments).
 */
import type { BackendId } from "@orkestrator/protocol/federation";
import type { BackendClient } from "@/lib/backend/client";
import type { PortalStore } from "./portal-store";

/** `backendId`'s node through the command node. */
export function routedBackendClient(
  portal: Pick<PortalStore, "invokeOnNode">,
  backendId: BackendId,
): BackendClient {
  return {
    invokeRaw: <T>(command: string, args?: Readonly<Record<string, unknown>>) =>
      portal.invokeOnNode<T>(backendId, command, args as Record<string, unknown> | undefined),
  };
}
