import type { BackendProfile } from "@orkestrator/protocol/backend-profile";
import type {
  NodeConnectionState,
  NodeListResult,
  NodeRoute,
  NodeStatus,
  NodeView,
} from "@orkestrator/protocol/command-nodes";
import type {
  ConnectionList,
  ConnectionRouteSummary,
  ConnectionSummary,
} from "@orkestrator/protocol/connections";
import type { HostMaintenanceSnapshot } from "@orkestrator/protocol/host-maintenance";

/**
 * One list of machines from the two places that know about them:
 *
 * - the command node this client is connected to (itself, and the nodes in
 *   its registry), which is what the portal, coordinators and maintenance
 *   use;
 * - this device's own saved connections (desktop only), which open windows
 *   and switch this window directly.
 *
 * Entries are merged by installation identity or by a shared address, so a
 * machine that is both a registered node and a saved connection, or is
 * saved more than once (Local and its Tailscale address), is listed once.
 */

/**
 * - `self`: the command node this client is connected to.
 * - `node`: a node in that command node's registry.
 * - `device`: saved on this device only; the command node does not know it.
 */
export type MachineRole = "self" | "node" | "device";

export interface MachineEntry {
  /** Stable React key. */
  key: string;
  role: MachineRole;
  /** Installation identity, when known. */
  nodeId: string | null;
  name: string;
  colorToken: string | undefined;
  /** Primary address (host or SSH destination), or null when there is none to show. */
  address: string | null;
  /** How it is reached, e.g. "Tailscale HTTPS" or "SSH". */
  via: string;
  connected: boolean;
  statusText: string;
  lastConnectedAt?: string;
  /** The machine this window's workspace is on. */
  current: boolean;
  node?: NodeView;
  connection?: ConnectionSummary;
  /** Whether host maintenance can be read: through the command node, or not at all. */
  maintenance: boolean;
}

export const NODE_STATE_TEXT: Record<NodeConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  degraded: "Degraded",
  unavailable: "Unavailable",
  quarantined: "Blocked: identity or trust check failed",
  "needs-credential": "Needs a gateway token",
  "needs-update": "Needs an Orkestrator update",
  suspended: "Suspended (this node is in leaf mode)",
  disabled: "Disabled",
};

const CONNECTION_STATE_TEXT: Record<string, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  authenticating: "Connecting…",
  reconnecting: "Reconnecting…",
  "authentication-required": "Needs a gateway token",
  "trust-blocked": "Blocked: verify this machine",
  incompatible: "Not supported by this client",
  disabled: "Not connected",
  unreachable: "Unavailable",
};

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function isTailscaleHost(host: string): boolean {
  return /\.ts\.net(?::\d+)?$/i.test(host);
}

function httpsVia(host: string): string {
  return isTailscaleHost(host) ? "Tailscale HTTPS" : "HTTPS";
}

export function nodeRouteAddress(route: NodeRoute): string {
  return route.kind === "https"
    ? hostOf(route.origin)
    : `${route.destination}${route.sshPort ? `:${route.sshPort}` : ""}`;
}

function nodeRouteVia(route: NodeRoute): string {
  return route.kind === "https" ? httpsVia(hostOf(route.origin)) : "SSH tunnel";
}

/** The route a node is using, else the first one it would try. */
function primaryNodeRoute(node: NodeView): NodeRoute | undefined {
  const active = node.routes.find((route) => route.id === node.connection.activeRouteId);
  if (active) return active;
  for (const id of node.routeOrder) {
    const route = node.routes.find((entry) => entry.id === id && entry.enabled);
    if (route) return route;
  }
  return node.routes[0];
}

function primaryConnectionRoute(connection: ConnectionSummary): ConnectionRouteSummary | undefined {
  const routes = connection.routes ?? [];
  return routes.find((route) => route.active) ?? routes.find((route) => route.enabled) ?? routes[0];
}

function connectionAddress(connection: ConnectionSummary): string | null {
  if (connection.address) return hostOf(connection.address);
  const route = primaryConnectionRoute(connection);
  if (route?.kind === "ssh") return route.sshDestination ?? route.label;
  return route?.label ?? null;
}

function connectionVia(connection: ConnectionSummary): string {
  if (connection.kind === "local") return "Local backend on this device";
  const route = primaryConnectionRoute(connection);
  if (route?.kind === "ssh") return "SSH tunnel";
  const address = connectionAddress(connection);
  return address ? httpsVia(address) : "HTTPS";
}

function connectionConnected(connection: ConnectionSummary): boolean {
  return connection.transport === "connected" || (connection.active && !connection.transport);
}

function connectionStatus(connection: ConnectionSummary): string {
  if (connection.requiresToken) return "Needs a gateway token";
  if (connection.active && (!connection.transport || connection.transport === "connected")) {
    return "Connected";
  }
  return CONNECTION_STATE_TEXT[connection.transport ?? "disabled"] ?? "Not connected";
}

/** The HTTPS hosts a saved connection reaches its machine at. */
function connectionHosts(connection: ConnectionSummary): Set<string> {
  const hosts = new Set<string>();
  if (connection.address) hosts.add(hostOf(connection.address).toLowerCase());
  for (const route of connection.routes ?? []) {
    if (route.kind !== "https" || !route.label) continue;
    hosts.add(
      hostOf(route.label.includes("://") ? route.label : `https://${route.label}`).toLowerCase(),
    );
  }
  return hosts;
}

function nodeHosts(node: NodeView): Set<string> {
  return new Set(
    node.routes.flatMap((route) =>
      route.kind === "https" ? [hostOf(route.origin).toLowerCase()] : [],
    ),
  );
}

/** The same machine: one proved identity, or (identity unknown or not) a shared address. */
function sameMachine(
  connection: ConnectionSummary,
  nodeId: string | null,
  hosts: Set<string>,
): boolean {
  if (nodeId && connection.backendId === nodeId) return true;
  for (const host of connectionHosts(connection)) if (hosts.has(host)) return true;
  return false;
}

function nodeConnected(node: NodeView): boolean {
  return node.connection.state === "connected" || node.connection.state === "degraded";
}

export interface MachineListInput {
  status: NodeStatus | null;
  nodes: NodeListResult | null;
  /** This device's saved connections; null outside the desktop app. */
  connections: ConnectionList | null;
  /** The command node's own profile. */
  selfProfile: BackendProfile | null;
  /** The node the window's workspace is on, when it is not the command node. */
  workspaceNodeId: string | null;
  /** Shown as the command node's address when no saved connection names it (browser clients). */
  selfAddress?: string | null;
}

export function buildMachineList(input: MachineListInput): MachineEntry[] {
  const { status, nodes, connections, selfProfile, workspaceNodeId } = input;
  const selfId: string | null = status?.nodeId ?? null;
  const saved = connections?.connections ?? [];
  const used = new Set<string>();
  const entries: MachineEntry[] = [];

  // The window's own connection is to the command node.
  const selfConnection =
    saved.find((connection) => connection.active) ??
    (selfId ? saved.find((connection) => connection.backendId === selfId) : undefined);
  const selfHosts = new Set([
    ...(selfConnection ? connectionHosts(selfConnection) : []),
    ...(input.selfAddress ? [hostOf(input.selfAddress).toLowerCase()] : []),
  ]);
  // Node discovery is optional; this window still has a backend to maintain.
  {
    if (selfConnection) used.add(selfConnection.id);
    // Other saved routes to this same machine are not machines of their own.
    for (const connection of saved) {
      if (sameMachine(connection, selfId, selfHosts)) used.add(connection.id);
    }
    entries.push({
      key: `self:${selfId ?? selfConnection?.id ?? "self"}`,
      role: "self",
      nodeId: selfId ?? selfConnection?.backendId ?? null,
      name:
        selfConnection?.nickname?.trim() ||
        (selfProfile?.displayName ??
          selfConnection?.profile?.displayName ??
          selfConnection?.name ??
          "This machine"),
      colorToken: selfProfile?.colorToken ?? selfConnection?.profile?.colorToken,
      address: selfConnection
        ? (connectionAddress(selfConnection) ??
          (selfConnection.kind === "local" ? "This device" : null))
        : (input.selfAddress ?? null),
      via: selfConnection ? connectionVia(selfConnection) : "This client's connection",
      connected: status !== null || (selfConnection ? connectionConnected(selfConnection) : true),
      statusText: status
        ? "Connected"
        : selfConnection
          ? connectionStatus(selfConnection)
          : "Connected",
      ...(selfConnection?.lastConnectedAt
        ? { lastConnectedAt: selfConnection.lastConnectedAt }
        : {}),
      current: workspaceNodeId === null,
      ...(selfConnection ? { connection: selfConnection } : {}),
      maintenance: true,
    });
  }

  for (const node of nodes?.nodes ?? []) {
    if (node.nodeId === selfId) continue;
    const hosts = nodeHosts(node);
    const matching = saved.filter(
      (candidate) => !used.has(candidate.id) && sameMachine(candidate, node.nodeId, hosts),
    );
    for (const candidate of matching) used.add(candidate.id);
    // Prefer the saved connection with the node's proved identity, then one with a token.
    const connection =
      matching.find(
        (candidate) => candidate.backendId === node.nodeId && !candidate.requiresToken,
      ) ??
      matching.find((candidate) => !candidate.requiresToken) ??
      matching[0];
    const route = primaryNodeRoute(node);
    const connected = nodeConnected(node);
    entries.push({
      key: `node:${node.nodeId}`,
      role: "node",
      nodeId: node.nodeId,
      name: connection?.nickname?.trim() || node.displayName,
      colorToken: node.colorToken,
      address: route ? nodeRouteAddress(route) : null,
      via: route ? nodeRouteVia(route) : "No route",
      connected,
      statusText: NODE_STATE_TEXT[node.connection.state],
      ...(node.lastConnectedAt ? { lastConnectedAt: node.lastConnectedAt } : {}),
      current: workspaceNodeId === node.nodeId,
      node,
      ...(connection ? { connection } : {}),
      maintenance: connected,
    });
  }

  for (const candidate of saved) {
    if (used.has(candidate.id)) continue;
    // Prefer a usable credential among duplicate device entries.
    const hosts = connectionHosts(candidate);
    const matching = saved.filter(
      (other) =>
        !used.has(other.id) &&
        (other === candidate || sameMachine(other, candidate.backendId ?? null, hosts)),
    );
    const connection = matching.find((other) => !other.requiresToken) ?? candidate;
    for (const other of matching) used.add(other.id);
    entries.push({
      key: `device:${connection.id}`,
      role: "device",
      nodeId: connection.backendId ?? null,
      name: connection.nickname?.trim() || connection.profile?.displayName || connection.name,
      colorToken: connection.profile?.colorToken,
      address:
        connectionAddress(connection) ?? (connection.kind === "local" ? "This device" : null),
      via: connectionVia(connection),
      connected: connectionConnected(connection),
      statusText: connectionStatus(connection),
      ...(connection.lastConnectedAt ? { lastConnectedAt: connection.lastConnectedAt } : {}),
      current: false,
      connection,
      maintenance: false,
    });
  }

  // The machine this window works on first, then the command node, then by name.
  const rank = (entry: MachineEntry) => (entry.current ? 0 : entry.role === "self" ? 1 : 2);
  return entries.sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

/**
 * What on a machine is out of date or needs repair, as short sentences.
 * Empty when everything it reports is current. A detailed snapshot adds the
 * tools and the container image; without it only Orkestrator is judged.
 */
export function maintenanceIssues(snapshot: HostMaintenanceSnapshot): string[] {
  const issues: string[] = [];
  if (snapshot.updater.updateAvailable === true) {
    issues.push(
      snapshot.updater.latestVersion
        ? `Orkestrator ${snapshot.updater.latestVersion} is available`
        : "An Orkestrator update is available",
    );
  }
  for (const tool of snapshot.tools ?? []) {
    if (tool.source === "missing") issues.push(`${tool.name} is missing`);
    else if (tool.source === "path") issues.push(`${tool.name} is not managed by Orkestrator`);
    else if (
      tool.channel !== "latest" &&
      tool.installedVersion !== null &&
      tool.installedVersion !== tool.pinnedVersion
    ) {
      issues.push(`${tool.name} ${tool.installedVersion} differs from ${tool.pinnedVersion}`);
    }
  }
  if (snapshot.image?.present && snapshot.image.compatible === false) {
    issues.push("The container image is out of date");
  }
  return issues;
}
