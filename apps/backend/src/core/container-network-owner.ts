import { runCommand } from "./shell.js";

/**
 * Which container owns a runtime's network namespace: its egress gateway
 * (`egress-gateway.ts`) when the runtime joined one with `--network
 * container:<gateway>`, otherwise the runtime itself. Published ports, the
 * firewall and its report, and the Docker network endpoint all belong to the
 * owner. A leaf, so `commands-container-exec` can use it without a cycle.
 */

/** Workload id → the container that owns its network namespace. Immutable. */
const networkOwners = new Map<string, string>();
const MAX_NETWORK_OWNERS = 512;

export function resetNetworkOwnerCache(): void {
  networkOwners.clear();
}

/** `container:<id>` network mode → that id; anything else → null. */
export function parseNetworkModeOwner(networkMode: string): string | null {
  const match = /^container:([0-9a-f]{64})$/.exec(networkMode.trim());
  return match?.[1] ?? null;
}

/**
 * The egress gateway whose namespace a workload joined, or null for a
 * container that owns its own network. A container's network mode never
 * changes, so a successful answer is cached.
 */
export async function egressGatewayOf(containerId: string): Promise<string | null> {
  const cached = networkOwners.get(containerId);
  if (cached !== undefined) return cached === containerId ? null : cached;
  // Only successful inspection proves absence. Daemon/transport failures
  // must keep start and teardown retryable, especially after a backend restart.
  const { stdout } = await runCommand(
    "docker",
    ["inspect", "--type", "container", "--format", "{{.HostConfig.NetworkMode}}", containerId],
    { timeoutMs: 10_000 },
  );
  const gateway = parseNetworkModeOwner(stdout);
  if (networkOwners.size >= MAX_NETWORK_OWNERS) {
    const oldest = networkOwners.keys().next().value;
    if (oldest !== undefined) networkOwners.delete(oldest);
  }
  networkOwners.set(containerId, gateway ?? containerId);
  return gateway;
}

/**
 * The container whose namespace holds a runtime's firewall, published ports
 * and network endpoint: its egress gateway, or the runtime itself.
 */
export async function networkOwnerContainer(containerId: string): Promise<string> {
  return (await egressGatewayOf(containerId)) ?? containerId;
}

/** Drops a removed container's cached answer. */
export function forgetNetworkOwner(containerId: string): void {
  networkOwners.delete(containerId);
}
