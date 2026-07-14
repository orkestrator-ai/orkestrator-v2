export const LOCAL_CONNECTION_ID = "local";

export type ConnectionKind = "local" | "remote";

export interface ConnectionSummary {
  id: string;
  name: string;
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
}

export interface ConnectToRemoteInput {
  address: string;
  token: string;
}

export interface StoredDesktopConnection {
  id: string;
  name: string;
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

export function parseStoredDesktopConnections(value: unknown): StoredDesktopConnections {
  const root = asRecord(value, "desktop connections");
  const activeConnectionId = asString(root.activeConnectionId, "activeConnectionId");
  if (!Array.isArray(root.connections)) throw new Error("Expected connections to be an array.");
  const connections = root.connections.map((value, index): StoredDesktopConnection => {
    const connection = asRecord(value, `connections[${index}]`);
    return {
      id: asString(connection.id, `connections[${index}].id`),
      name: asString(connection.name, `connections[${index}].name`),
      address: asString(connection.address, `connections[${index}].address`),
      encryptedToken: asString(connection.encryptedToken, `connections[${index}].encryptedToken`),
      lastConnectedAt: asString(connection.lastConnectedAt, `connections[${index}].lastConnectedAt`),
    };
  });
  return { activeConnectionId, connections };
}

export function parseConnectionList(value: unknown): ConnectionList {
  const root = asRecord(value, "connection list");
  const activeConnectionId = asString(root.activeConnectionId, "activeConnectionId");
  if (!Array.isArray(root.connections)) throw new Error("Expected connections to be an array.");
  const credentialStorage = root.credentialStorage;
  if (credentialStorage !== undefined && credentialStorage !== "secure" && credentialStorage !== "session-only") {
    throw new Error("Expected credentialStorage to be secure or session-only.");
  }
  const connections = root.connections.map((value, index): ConnectionSummary => {
    const connection = asRecord(value, `connections[${index}]`);
    const kind = connection.kind;
    if (kind !== "local" && kind !== "remote") throw new Error(`Expected connections[${index}].kind to be local or remote.`);
    if (connection.address !== null && typeof connection.address !== "string") {
      throw new Error(`Expected connections[${index}].address to be a string or null.`);
    }
    if (typeof connection.active !== "boolean" || typeof connection.requiresToken !== "boolean") {
      throw new Error(`Expected connections[${index}] activity fields to be booleans.`);
    }
    if (connection.lastConnectedAt !== undefined && typeof connection.lastConnectedAt !== "string") {
      throw new Error(`Expected connections[${index}].lastConnectedAt to be a string.`);
    }
    return {
      id: asString(connection.id, `connections[${index}].id`),
      name: asString(connection.name, `connections[${index}].name`),
      address: connection.address,
      kind,
      active: connection.active,
      requiresToken: connection.requiresToken,
      ...(connection.lastConnectedAt === undefined ? {} : { lastConnectedAt: connection.lastConnectedAt }),
    };
  });
  return {
    activeConnectionId,
    connections,
    ...(credentialStorage === undefined ? {} : { credentialStorage }),
  };
}
