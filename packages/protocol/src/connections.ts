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
