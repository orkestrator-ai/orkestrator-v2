/**
 * How a node client addresses one of its node's loopback ports for this
 * computer's external browser: through that node's own loopback proxy
 * (`/__orkestrator/proxy/loopback/<port>`), never the command node's, which
 * would answer with its own port.
 *
 * The browser leaf lease resolves against the command node's relay for the
 * leaf; the desktop node client asks main for the node's current route
 * (`nodes.gateway(nodeId)`), because the renderer holds no route of its own.
 */
export interface ExternalLoopbackAddressing {
  /**
   * The loopback URL through the node's own proxy. Rejects while the node has
   * no route (its scope is not open, or it is reconnecting).
   */
  resolveExternalLoopbackUrl(url: string): Promise<string>;
}

/** The client's resolver, or null for a client that cannot address its node's loopback ports. */
export function externalLoopbackResolver(
  client: unknown,
): ExternalLoopbackAddressing["resolveExternalLoopbackUrl"] | null {
  const candidate = client as Partial<ExternalLoopbackAddressing> | null | undefined;
  return typeof candidate?.resolveExternalLoopbackUrl === "function"
    ? (url) => candidate.resolveExternalLoopbackUrl!(url)
    : null;
}
