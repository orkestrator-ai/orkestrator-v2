import type { BackendId } from "./federation.js";

export const LOCAL_CONNECTION_ID = "local";

export type ConnectionKind = "local" | "remote";

/**
 * Transport state of one machine, independent of resource freshness and of
 * agent activity (see `docs/architecture/federation.md`).
 */
export type ConnectionTransportState =
  | "disabled"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "authentication-required"
  | "trust-blocked"
  | "incompatible"
  | "unreachable";

export const CONNECTION_TRANSPORT_STATES: readonly ConnectionTransportState[] = [
  "disabled",
  "connecting",
  "authenticating",
  "connected",
  "reconnecting",
  "authentication-required",
  "trust-blocked",
  "incompatible",
  "unreachable",
];

/** Whether the client has proved which installation answers this machine's routes. */
export type ConnectionIdentityState = "verified" | "provisional" | "conflict";

/** Safe, renderer-visible metadata for one saved route. Never contains a token. */
export interface ConnectionRouteSummary {
  id: string;
  kind: "https" | "ssh" | "local";
  /** Short non-secret description, e.g. a host or `ssh build-machine`. */
  label: string;
  enabled: boolean;
  active: boolean;
  /** Why the route is quarantined, when a trust or credential failure blocked it. */
  blockedReason?: string;
  /** False in a client that cannot use this kind of route (an SSH route in a browser). */
  supported: boolean;
  /** SSH routes: the user's own destination/alias and optional port (never key material). */
  sshDestination?: string;
  sshPort?: number;
}

export interface ConnectionProfileSummary {
  displayName: string;
  colorToken: string;
  revision: number;
  /** True when shown from the last-known cache rather than a live hello. */
  cached: boolean;
}

export interface ConnectionSummary {
  id: string;
  /** Display name: the user's nickname when set, otherwise the server hostname. */
  name: string;
  /** User-assigned nickname. Absent when the connection uses its hostname. */
  nickname?: string;
  address: string | null;
  kind: ConnectionKind;
  active: boolean;
  requiresToken: boolean;
  lastConnectedAt?: string;
  /** Verified installation identity, when known. */
  backendId?: BackendId;
  identity?: ConnectionIdentityState;
  /** Canonical backend profile (name + colour), live or last-known. */
  profile?: ConnectionProfileSummary;
  transport?: ConnectionTransportState;
  /** Sanitized, bounded diagnostic for the current transport state. */
  transportDetail?: string;
  routes?: ConnectionRouteSummary[];
  /** Backend generation from the last successful hello. */
  generation?: string;
  lastHelloAt?: string;
  /** Round trip of the last authenticated handshake, in milliseconds. */
  latencyMs?: number;
  /** Capability names the machine negotiated (names only). */
  capabilities?: string[];
  /** Whether multi-machine views connect this machine automatically. */
  autoConnect?: boolean;
}

export interface ConnectionList {
  activeConnectionId: string;
  connections: ConnectionSummary[];
  credentialStorage?: "secure" | "session-only";
  /** Whether the desktop-owned Local backend can currently accept work. */
  localAvailable?: boolean;
  /** Client feature flags (federation, SSH routes, route fallback). */
  features?: { federation: boolean; sshRoutes: boolean; routeFallback: boolean };
  /** Route kinds this client can open itself. */
  supportedRouteKinds?: Array<"https" | "ssh">;
}

/** Input for adding a managed SSH route (desktop only). */
export interface ConnectSshRouteInput {
  destination: string;
  sshPort?: number;
  identityFile?: string;
  remoteGatewayPort: number;
  token: string;
  nickname?: string;
  /** Attach the route to this existing machine instead of onboarding a new one. */
  connectionId?: string;
  /** Bind the requesting window to the new machine; defaults to false. */
  select?: boolean;
}

export interface ConnectToRemoteInput {
  address: string;
  token: string;
  /** Optional nickname. Omitted or blank keeps an existing nickname for a known address. */
  nickname?: string;
  /**
   * Bind the requesting window to this machine (the single-machine switch).
   * `false` only adds the machine; multi-machine views observe it in place.
   */
  select?: boolean;
  /**
   * Add this address as another route of an existing, verified machine. The
   * address must prove the same installation; nothing is merged otherwise.
   */
  connectionId?: string;
}

export const MAX_CONNECTION_NICKNAME_LENGTH = 64;

/**
 * Normalize a user-entered connection nickname. Whitespace is collapsed and
 * control characters are removed; a blank value means "use the hostname" and
 * returns `undefined`.
 */
export function normalizeConnectionNickname(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Expected the nickname to be a string.");
  // oxlint-disable-next-line no-control-regex -- strips control characters from user input
  const nickname = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!nickname) return undefined;
  if (Array.from(nickname).length > MAX_CONNECTION_NICKNAME_LENGTH) {
    throw new Error(`Use a nickname of ${MAX_CONNECTION_NICKNAME_LENGTH} characters or fewer.`);
  }
  return nickname;
}

/** The name shown for a saved connection: its nickname, falling back to the stored hostname. */
export function connectionDisplayName(connection: { name: string; nickname?: string }): string {
  return connection.nickname || connection.name;
}

/**
 * Expand a bare Tailscale machine name using the first known `.ts.net`
 * connection. Tailscale HTTPS certificates cover the full MagicDNS name, not
 * the bare hostname, so retaining the suffix is required for TLS validation.
 */
export function expandTailscaleMachineName(
  value: string,
  knownAddresses: readonly string[],
): string {
  const candidate = value.trim();
  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(candidate) ||
    candidate.toLowerCase() === "localhost"
  ) {
    return candidate;
  }

  for (const address of knownAddresses) {
    try {
      const hostname = new URL(address).hostname;
      const firstDot = hostname.indexOf(".");
      if (firstDot < 1) continue;
      const tailnetSuffix = hostname.slice(firstDot + 1);
      if (tailnetSuffix.endsWith(".ts.net")) return `${candidate}.${tailnetSuffix}`;
    } catch {
      // Ignore malformed historical entries and keep looking for a usable suffix.
    }
  }

  return candidate;
}

export interface StoredDesktopConnection {
  id: string;
  /** Server hostname derived from the address. */
  name: string;
  /** User-assigned display nickname. */
  nickname?: string;
  address: string;
  encryptedToken: string;
  lastConnectedAt: string;
}

export interface StoredDesktopConnections {
  activeConnectionId: string;
  connections: StoredDesktopConnection[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Expected ${label} to be a string.`);
  return value;
}

function optionalNickname(value: unknown, label: string): { nickname?: string } {
  if (value === undefined || value === null) return {};
  const nickname = asString(value, label);
  return nickname ? { nickname } : {};
}

export function parseStoredDesktopConnections(value: unknown): StoredDesktopConnections {
  const root = asRecord(value, "desktop connections");
  const activeConnectionId = asString(root.activeConnectionId, "activeConnectionId");
  if (!Array.isArray(root.connections)) throw new Error("Expected connections to be an array.");
  const connections = root.connections.map((value, index): StoredDesktopConnection => {
    const connection = asRecord(value, `connections[${index}]`);
    return {
      id: asString(connection.id, `connections[${index}].id`),
      name: asString(connection.name, `connections[${index}].name`),
      ...optionalNickname(connection.nickname, `connections[${index}].nickname`),
      address: asString(connection.address, `connections[${index}].address`),
      encryptedToken: asString(connection.encryptedToken, `connections[${index}].encryptedToken`),
      lastConnectedAt: asString(
        connection.lastConnectedAt,
        `connections[${index}].lastConnectedAt`,
      ),
    };
  });
  return { activeConnectionId, connections };
}

export function parseConnectionList(value: unknown): ConnectionList {
  const root = asRecord(value, "connection list");
  const activeConnectionId = asString(root.activeConnectionId, "activeConnectionId");
  if (!Array.isArray(root.connections)) throw new Error("Expected connections to be an array.");
  const credentialStorage = root.credentialStorage;
  if (
    credentialStorage !== undefined &&
    credentialStorage !== "secure" &&
    credentialStorage !== "session-only"
  ) {
    throw new Error("Expected credentialStorage to be secure or session-only.");
  }
  const localAvailable = root.localAvailable;
  if (localAvailable !== undefined && typeof localAvailable !== "boolean") {
    throw new Error("Expected localAvailable to be a boolean.");
  }
  const connections = root.connections.map((value, index): ConnectionSummary => {
    const connection = asRecord(value, `connections[${index}]`);
    const kind = connection.kind;
    if (kind !== "local" && kind !== "remote")
      throw new Error(`Expected connections[${index}].kind to be local or remote.`);
    if (connection.address !== null && typeof connection.address !== "string") {
      throw new Error(`Expected connections[${index}].address to be a string or null.`);
    }
    if (typeof connection.active !== "boolean" || typeof connection.requiresToken !== "boolean") {
      throw new Error(`Expected connections[${index}] activity fields to be booleans.`);
    }
    if (
      connection.lastConnectedAt !== undefined &&
      typeof connection.lastConnectedAt !== "string"
    ) {
      throw new Error(`Expected connections[${index}].lastConnectedAt to be a string.`);
    }
    return {
      id: asString(connection.id, `connections[${index}].id`),
      name: asString(connection.name, `connections[${index}].name`),
      ...optionalNickname(connection.nickname, `connections[${index}].nickname`),
      address: connection.address,
      kind,
      active: connection.active,
      requiresToken: connection.requiresToken,
      ...(connection.lastConnectedAt === undefined
        ? {}
        : { lastConnectedAt: connection.lastConnectedAt }),
      ...parseFederatedSummaryFields(connection),
    };
  });
  return {
    activeConnectionId,
    connections,
    ...(credentialStorage === undefined ? {} : { credentialStorage }),
    ...(localAvailable === undefined ? {} : { localAvailable }),
    ...parseListFeatures(root),
  };
}

function parseListFeatures(root: Record<string, unknown>): Partial<ConnectionList> {
  const result: Partial<ConnectionList> = {};
  const features = root.features;
  if (features && typeof features === "object" && !Array.isArray(features)) {
    const record = features as Record<string, unknown>;
    result.features = {
      federation: record.federation === true,
      sshRoutes: record.sshRoutes === true,
      routeFallback: record.routeFallback === true,
    };
  }
  if (Array.isArray(root.supportedRouteKinds)) {
    result.supportedRouteKinds = root.supportedRouteKinds.filter(
      (kind): kind is "https" | "ssh" => kind === "https" || kind === "ssh",
    );
  }
  return result;
}

const MAX_SUMMARY_TEXT = 256;

function boundedOptionalText(value: unknown, max = MAX_SUMMARY_TEXT): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  // oxlint-disable-next-line no-control-regex -- backend-sourced text is rendered as plain text
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

/**
 * Optional federation fields. Unknown or malformed values are dropped rather
 * than failing the whole list, so a newer main process cannot break an older
 * renderer's switcher.
 */
function parseFederatedSummaryFields(
  connection: Record<string, unknown>,
): Partial<ConnectionSummary> {
  const result: Partial<ConnectionSummary> = {};
  if (
    typeof connection.backendId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(connection.backendId)
  ) {
    result.backendId = connection.backendId as BackendId;
  }
  if (
    connection.identity === "verified" ||
    connection.identity === "provisional" ||
    connection.identity === "conflict"
  ) {
    result.identity = connection.identity;
  }
  const profile = connection.profile;
  if (profile && typeof profile === "object" && !Array.isArray(profile)) {
    const record = profile as Record<string, unknown>;
    const displayName = boundedOptionalText(record.displayName, 64);
    const colorToken = boundedOptionalText(record.colorToken, 32);
    if (displayName && colorToken && Number.isSafeInteger(record.revision)) {
      result.profile = {
        displayName,
        colorToken,
        revision: record.revision as number,
        cached: record.cached === true,
      };
    }
  }
  if (
    typeof connection.transport === "string" &&
    (CONNECTION_TRANSPORT_STATES as readonly string[]).includes(connection.transport)
  ) {
    result.transport = connection.transport as ConnectionTransportState;
  }
  const transportDetail = boundedOptionalText(connection.transportDetail);
  if (transportDetail) result.transportDetail = transportDetail;
  const generation = boundedOptionalText(connection.generation, 200);
  if (generation) result.generation = generation;
  const lastHelloAt = boundedOptionalText(connection.lastHelloAt, 64);
  if (lastHelloAt) result.lastHelloAt = lastHelloAt;
  if (
    typeof connection.latencyMs === "number" &&
    Number.isFinite(connection.latencyMs) &&
    connection.latencyMs >= 0
  ) {
    result.latencyMs = Math.min(Math.round(connection.latencyMs), 600_000);
  }
  if (Array.isArray(connection.capabilities)) {
    result.capabilities = connection.capabilities
      .filter(
        (name): name is string => typeof name === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(name),
      )
      .slice(0, 64);
  }
  if (typeof connection.autoConnect === "boolean") result.autoConnect = connection.autoConnect;
  if (Array.isArray(connection.routes)) {
    result.routes = connection.routes.slice(0, 8).flatMap((route): ConnectionRouteSummary[] => {
      if (!route || typeof route !== "object" || Array.isArray(route)) return [];
      const record = route as Record<string, unknown>;
      const id = boundedOptionalText(record.id, 128);
      const label = boundedOptionalText(record.label);
      if (
        !id ||
        !label ||
        (record.kind !== "https" && record.kind !== "ssh" && record.kind !== "local")
      ) {
        return [];
      }
      const blockedReason = boundedOptionalText(record.blockedReason);
      const sshDestination = boundedOptionalText(record.sshDestination);
      const sshPort =
        Number.isSafeInteger(record.sshPort) &&
        (record.sshPort as number) > 0 &&
        (record.sshPort as number) <= 65_535
          ? (record.sshPort as number)
          : undefined;
      return [
        {
          id,
          kind: record.kind,
          label,
          enabled: record.enabled !== false,
          active: record.active === true,
          supported: record.supported !== false,
          ...(blockedReason ? { blockedReason } : {}),
          ...(sshDestination ? { sshDestination } : {}),
          ...(sshPort ? { sshPort } : {}),
        },
      ];
    });
  }
  return result;
}
