export const LOCAL_CONNECTION_ID = "local";

export type ConnectionKind = "local" | "remote";

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
}

export interface ConnectionList {
  activeConnectionId: string;
  connections: ConnectionSummary[];
  credentialStorage?: "secure" | "session-only";
  /** Whether the desktop-owned Local backend can currently accept work. */
  localAvailable?: boolean;
}

export interface ConnectToRemoteInput {
  address: string;
  token: string;
  /** Optional nickname. Omitted or blank keeps an existing nickname for a known address. */
  nickname?: string;
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
  if (value === undefined) return {};
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
    };
  });
  return {
    activeConnectionId,
    connections,
    ...(credentialStorage === undefined ? {} : { credentialStorage }),
    ...(localAvailable === undefined ? {} : { localAvailable }),
  };
}
