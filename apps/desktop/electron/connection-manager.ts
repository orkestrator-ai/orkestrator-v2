import { randomUUID } from "node:crypto";
import {
  expandTailscaleMachineName,
  LOCAL_CONNECTION_ID,
  parseStoredDesktopConnections,
  type ConnectToRemoteInput,
  type ConnectionList,
  type StoredDesktopConnection,
  type StoredDesktopConnections,
} from "@orkestrator/protocol/connections";
import { normalizeGatewayToken } from "@orkestrator/protocol/gateway-token";
import type { GatewayTokenSettings, WebClientStatus } from "@orkestrator/protocol/web-client";
import { BackendHttpClient } from "./backend-process.js";

type LocalBackend = Pick<
  BackendHttpClient,
  | "invoke"
  | "probe"
  | "getWebClientStatus"
  | "setWebClientEnabled"
  | "resetWebClientServe"
  | "getTokenSettings"
  | "setToken"
>;

export type SecureStorage = {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
};

export type ConnectionManagerOptions = {
  localBackend: LocalBackend;
  secureStorage: SecureStorage;
  platform?: NodeJS.Platform;
  connectionTimeoutMs?: number;
  onEvent: (event: string, payload: unknown) => void;
  onConnectionEvent?: (connectionId: string, event: string, payload: unknown) => void;
};

const CONNECTION_TIMEOUT_MS = 10_000;
const CONNECTION_PROBE_TIMEOUT_MS = 3_000;
export const DEFAULT_CONNECTION_SCOPE = "default";

type RemoteConnection = {
  record: StoredDesktopConnection;
  client: BackendHttpClient;
  token: string;
  scopes: Set<string>;
};

function normalizeRemoteAddress(value: string, knownAddresses: readonly string[] = []): string {
  const candidate = expandTailscaleMachineName(value, knownAddresses);
  if (!candidate) throw new Error("Enter the backend address.");
  if (
    candidate === value.trim() &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(candidate) &&
    candidate.toLowerCase() !== "localhost"
  ) {
    throw new Error(
      "Enter the full Tailscale HTTPS address once. Saved machines on that tailnet can then use a short name.",
    );
  }

  let url: URL;
  try {
    url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  } catch {
    throw new Error("Enter a valid backend URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The backend address must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Put the gateway token in the token field, not in the URL.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use the backend origin only, without a path, query, or fragment.");
  }
  const isLoopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("Remote backends must use HTTPS. Use the HTTPS address exposed by Tailscale.");
  }
  return url.origin;
}

function connectionName(address: string): string {
  return new URL(address).hostname;
}

export class ConnectionManager {
  private readonly localBackend: LocalBackend;
  private readonly secureStorage: SecureStorage;
  private readonly platform: NodeJS.Platform;
  private readonly onEvent: (event: string, payload: unknown) => void;
  private readonly onConnectionEvent?: (
    connectionId: string,
    event: string,
    payload: unknown,
  ) => void;
  private readonly connectionTimeoutMs: number;
  private stored: StoredDesktopConnections = {
    activeConnectionId: LOCAL_CONNECTION_ID,
    connections: [],
  };
  private readonly bindings = new Map<string, string>();
  private readonly remoteConnections = new Map<string, RemoteConnection>();
  private secureStorageAvailable = false;
  private localBackendAvailable = true;
  private readonly sessionTokens = new Map<string, string>();
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: ConnectionManagerOptions) {
    this.localBackend = options.localBackend;
    this.secureStorage = options.secureStorage;
    this.platform = options.platform ?? process.platform;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS;
    if (!Number.isFinite(this.connectionTimeoutMs) || this.connectionTimeoutMs <= 0) {
      throw new Error("Connection timeout must be a positive number of milliseconds.");
    }
    this.onEvent = options.onEvent;
    this.onConnectionEvent = options.onConnectionEvent;
  }

  async initialize(): Promise<void> {
    this.secureStorageAvailable = await this.detectSecureStorage();
    this.stored = parseStoredDesktopConnections(
      await this.localBackend.invoke<StoredDesktopConnections>("get_desktop_connections"),
    );
    this.bindings.set(DEFAULT_CONNECTION_SCOPE, LOCAL_CONNECTION_ID);
    if (this.stored.activeConnectionId === LOCAL_CONNECTION_ID) return;
    try {
      await this.activateRemote(DEFAULT_CONNECTION_SCOPE, this.stored.activeConnectionId, false);
    } catch (error) {
      console.warn(
        "[Connections] Could not restore the previous remote connection; using Local:",
        error,
      );
      const fallback = { ...this.stored, activeConnectionId: LOCAL_CONNECTION_ID };
      await this.persist(fallback);
      this.stored = fallback;
      this.bindings.set(DEFAULT_CONNECTION_SCOPE, LOCAL_CONNECTION_ID);
    }
  }

  getList(scope = DEFAULT_CONNECTION_SCOPE): ConnectionList {
    const activeConnectionId = this.connectionIdForScope(scope);
    return {
      activeConnectionId,
      credentialStorage: this.secureStorageAvailable ? "secure" : "session-only",
      connections: [
        {
          id: LOCAL_CONNECTION_ID,
          name: "Local",
          address: null,
          kind: "local",
          active: activeConnectionId === LOCAL_CONNECTION_ID,
          requiresToken: false,
        },
        ...this.stored.connections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          address: connection.address,
          kind: "remote" as const,
          active: activeConnectionId === connection.id,
          requiresToken:
            connection.id !== activeConnectionId &&
            !connection.encryptedToken &&
            !this.sessionTokens.has(connection.id),
          lastConnectedAt: connection.lastConnectedAt,
        })),
      ],
    };
  }

  async connect(
    input: ConnectToRemoteInput,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    return this.enqueueMutation(async () => {
      const address = normalizeRemoteAddress(
        input.address,
        [
          this.stored.connections.find(
            (connection) => connection.id === this.stored.activeConnectionId,
          ),
          ...this.stored.connections,
        ].flatMap((connection) => (connection ? [connection.address] : [])),
      );
      const token = normalizeGatewayToken(input.token);
      this.secureStorageAvailable = await this.detectSecureStorage();

      const client = new BackendHttpClient(address, token);
      await this.checkRemote(address, token);
      const encryptedToken = this.secureStorageAvailable
        ? (await this.secureStorage.encryptStringAsync(token)).toString("base64")
        : "";
      const existing = this.stored.connections.find((connection) => connection.address === address);
      const record: StoredDesktopConnection = {
        id: existing?.id ?? randomUUID(),
        name: connectionName(address),
        address,
        encryptedToken,
        lastConnectedAt: new Date().toISOString(),
      };
      const candidate: StoredDesktopConnections = {
        activeConnectionId: record.id,
        connections: [
          record,
          ...this.stored.connections.filter((connection) => connection.id !== record.id),
        ],
      };
      await this.persist(candidate);
      this.stored = candidate;
      this.sessionTokens.set(record.id, token);
      this.setScopeRemote(scope, record, client, token);
      return this.getList(scope);
    });
  }

  async use(connectionId: string, scope = DEFAULT_CONNECTION_SCOPE): Promise<ConnectionList> {
    return this.enqueueMutation(async () => {
      if (connectionId === LOCAL_CONNECTION_ID) {
        const candidate = { ...this.stored, activeConnectionId: LOCAL_CONNECTION_ID };
        await this.persist(candidate);
        this.stored = candidate;
        this.setScopeLocal(scope);
        return this.getList(scope);
      }
      await this.activateRemote(scope, connectionId, true);
      return this.getList(scope);
    });
  }

  async forget(connectionId: string, scope = DEFAULT_CONNECTION_SCOPE): Promise<ConnectionList> {
    return this.enqueueMutation(async () => {
      if (connectionId === LOCAL_CONNECTION_ID)
        throw new Error("The Local connection cannot be removed.");
      if (!this.stored.connections.some((connection) => connection.id === connectionId)) {
        throw new Error("That saved connection no longer exists.");
      }
      const activeScopes = Array.from(this.bindings.entries())
        .filter(([, activeConnectionId]) => activeConnectionId === connectionId)
        .map(([scope]) => scope);
      if (
        activeScopes.some(
          (activeScope) => activeScope !== DEFAULT_CONNECTION_SCOPE && activeScope !== scope,
        )
      ) {
        throw new Error("Switch or close every window using this connection before removing it.");
      }
      const candidate: StoredDesktopConnections = {
        activeConnectionId:
          this.stored.activeConnectionId === connectionId
            ? LOCAL_CONNECTION_ID
            : this.stored.activeConnectionId,
        connections: this.stored.connections.filter((connection) => connection.id !== connectionId),
      };
      await this.persist(candidate);
      this.stored = candidate;
      this.sessionTokens.delete(connectionId);
      for (const activeScope of activeScopes) this.setScopeLocal(activeScope);
      return this.getList(scope);
    });
  }

  async updateToken(
    connectionId: string,
    value: string,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<ConnectionList> {
    return this.enqueueMutation(async () => {
      const storedRecord = this.stored.connections.find(
        (connection) => connection.id === connectionId,
      );
      if (!storedRecord) throw new Error("That saved connection no longer exists.");

      const token = normalizeGatewayToken(value);
      await this.checkRemote(storedRecord.address, token);
      this.secureStorageAvailable = await this.detectSecureStorage();
      let encryptedToken = "";
      if (this.secureStorageAvailable) {
        try {
          encryptedToken = (await this.secureStorage.encryptStringAsync(token)).toString("base64");
        } catch {
          // The token was already accepted by the server. Keep it usable for
          // this process even when the OS credential store fails mid-write.
          this.secureStorageAvailable = false;
        }
      }
      const record = { ...storedRecord, encryptedToken };
      const candidate: StoredDesktopConnections = {
        ...this.stored,
        connections: this.stored.connections.map((connection) =>
          connection.id === connectionId ? record : connection,
        ),
      };
      await this.persist(candidate);
      this.stored = candidate;
      this.sessionTokens.set(connectionId, token);

      this.replaceRemoteConnection(record, token);
      return this.getList(scope);
    });
  }

  async probe(connectionId: string): Promise<boolean> {
    const timeoutMs = Math.min(this.connectionTimeoutMs, CONNECTION_PROBE_TIMEOUT_MS);
    if (connectionId === LOCAL_CONNECTION_ID) {
      if (!this.localBackendAvailable) return false;
      try {
        return await this.localBackend.probe(timeoutMs);
      } catch {
        return false;
      }
    }

    const record = this.stored.connections.find((connection) => connection.id === connectionId);
    if (!record) return false;

    try {
      let token: string;
      const activeRemote = this.remoteConnections.get(connectionId);
      if (activeRemote) {
        token = activeRemote.token;
      } else {
        if (!record.encryptedToken || !this.secureStorageAvailable) return false;
        const decrypted = await this.secureStorage.decryptStringAsync(
          Buffer.from(record.encryptedToken, "base64"),
        );
        token = normalizeGatewayToken(decrypted.result);
      }
      await this.checkRemote(record.address, token, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  invoke<T>(
    command: string,
    args: Record<string, unknown> = {},
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<T> {
    return this.currentBackend(scope).invoke<T>(command, args);
  }

  handleLocalEvent(event: string, payload: unknown): void {
    if (!this.localBackendAvailable) return;
    this.dispatchConnectionEvent(LOCAL_CONNECTION_ID, event, payload);
  }

  markLocalBackendUnavailable(): void {
    this.localBackendAvailable = false;
  }

  getRendererRequestAuthorization(
    urlValue: string,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): string | null {
    const activeRemote = this.remoteForScope(scope);
    if (!activeRemote) return null;
    try {
      const url = new URL(urlValue);
      if (
        url.origin !== activeRemote.record.address ||
        !url.pathname.startsWith("/__orkestrator/")
      ) {
        return null;
      }
      return `Bearer ${activeRemote.token}`;
    } catch {
      return null;
    }
  }

  getWebClientStatus(scope = DEFAULT_CONNECTION_SCOPE): Promise<WebClientStatus> {
    return this.currentBackend(scope).getWebClientStatus();
  }

  setWebClientEnabled(
    enabled: boolean,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<WebClientStatus> {
    return this.currentBackend(scope).setWebClientEnabled(enabled);
  }

  resetWebClientServe(scope = DEFAULT_CONNECTION_SCOPE): Promise<WebClientStatus> {
    return this.currentBackend(scope).resetWebClientServe();
  }

  getGatewayTokenSettings(scope = DEFAULT_CONNECTION_SCOPE): Promise<GatewayTokenSettings> {
    return this.currentBackend(scope).getTokenSettings();
  }

  getTokenSettings(scope = DEFAULT_CONNECTION_SCOPE): Promise<GatewayTokenSettings> {
    return this.getGatewayTokenSettings(scope);
  }

  async setGatewayToken(
    token: string,
    scope = DEFAULT_CONNECTION_SCOPE,
  ): Promise<GatewayTokenSettings> {
    return this.enqueueMutation(async () => {
      const target = this.remoteForScope(scope);
      const settings = await this.currentBackend(scope).setToken(token);
      if (!target) return settings;

      target.token = settings.token;
      this.sessionTokens.set(target.record.id, settings.token);
      this.secureStorageAvailable = await this.detectSecureStorage();
      let encryptedToken = "";
      try {
        encryptedToken = this.secureStorageAvailable
          ? (await this.secureStorage.encryptStringAsync(settings.token)).toString("base64")
          : "";
        const record = { ...target.record, encryptedToken };
        const candidate = this.replaceStoredRecord(record);
        await this.persist(candidate);
        this.stored = candidate;
        this.replaceRemoteConnection(record, settings.token);
      } catch (error) {
        const sessionRecord = { ...target.record, encryptedToken: "" };
        this.stored = this.replaceStoredRecord(sessionRecord);
        this.replaceRemoteConnection(sessionRecord, settings.token);
        throw error;
      }
      return settings;
    });
  }

  setToken(token: string, scope = DEFAULT_CONNECTION_SCOPE): Promise<GatewayTokenSettings> {
    return this.setGatewayToken(token, scope);
  }

  getConnectionId(scope = DEFAULT_CONNECTION_SCOPE): string {
    return this.connectionIdForScope(scope);
  }

  async bind(
    scope: string,
    connectionId = this.stored.activeConnectionId,
  ): Promise<ConnectionList> {
    return this.enqueueMutation(async () => {
      if (!scope) throw new Error("Connection scope cannot be empty.");
      if (connectionId === LOCAL_CONNECTION_ID) {
        this.setScopeLocal(scope);
        return this.getList(scope);
      }
      await this.activateRemote(scope, connectionId, false, false);
      return this.getList(scope);
    });
  }

  release(scope: string): void {
    this.releaseScopeRemote(scope);
    this.bindings.delete(scope);
  }

  private currentBackend(scope: string): LocalBackend {
    const connectionId = this.connectionIdForScope(scope);
    if (connectionId === LOCAL_CONNECTION_ID) return this.localBackend;
    const remote = this.remoteConnections.get(connectionId);
    if (!remote) throw new Error("The selected remote connection is not available.");
    return remote.client;
  }

  private async activateRemote(
    scope: string,
    connectionId: string,
    updateLastConnected: boolean,
    persistSelection = true,
  ): Promise<void> {
    const storedRecord = this.stored.connections.find(
      (connection) => connection.id === connectionId,
    );
    if (!storedRecord) throw new Error("That saved connection no longer exists.");
    const sessionToken = this.sessionTokens.get(connectionId);
    if (!storedRecord.encryptedToken && !sessionToken) {
      throw new Error("Enter the gateway token to reconnect to this server.");
    }
    this.secureStorageAvailable = await this.detectSecureStorage();
    if (!this.secureStorageAvailable && !sessionToken) {
      throw new Error("Secure credential storage is unavailable. Enter the gateway token again.");
    }
    const decrypted =
      !sessionToken && storedRecord.encryptedToken
        ? await this.secureStorage.decryptStringAsync(
            Buffer.from(storedRecord.encryptedToken, "base64"),
          )
        : null;
    const token = normalizeGatewayToken(sessionToken ?? decrypted?.result ?? "");
    const existingRemote = this.remoteConnections.get(connectionId);
    const client = existingRemote?.client ?? new BackendHttpClient(storedRecord.address, token);
    await this.checkRemote(storedRecord.address, token);
    const record = { ...storedRecord };
    if (decrypted?.shouldReEncrypt) {
      record.encryptedToken = (await this.secureStorage.encryptStringAsync(token)).toString(
        "base64",
      );
    }
    if (updateLastConnected) record.lastConnectedAt = new Date().toISOString();
    const candidate: StoredDesktopConnections = {
      activeConnectionId: persistSelection ? record.id : this.stored.activeConnectionId,
      connections: this.stored.connections.map((connection) =>
        connection.id === record.id ? record : connection,
      ),
    };
    if (persistSelection) await this.persist(candidate);
    this.stored = candidate;
    this.sessionTokens.set(record.id, token);
    this.setScopeRemote(scope, record, client, token);
  }

  private setScopeRemote(
    scope: string,
    record: StoredDesktopConnection,
    client: BackendHttpClient,
    token: string,
  ): void {
    this.releaseScopeRemote(scope);
    const existing = this.remoteConnections.get(record.id);
    if (existing && existing.client === client) {
      existing.record = record;
      existing.token = token;
      existing.scopes.add(scope);
      this.bindings.set(scope, record.id);
      return;
    }
    const scopes = new Set(existing?.scopes ?? []);
    scopes.add(scope);
    existing?.client.stopListening();
    const remote: RemoteConnection = { record, client, token, scopes };
    this.remoteConnections.set(record.id, remote);
    for (const boundScope of scopes) this.bindings.set(boundScope, record.id);
    this.startRemoteListener(record.id, client);
  }

  private startRemoteListener(connectionId: string, client: BackendHttpClient): void {
    client.listen((event, payload) => {
      if (this.remoteConnections.get(connectionId)?.client === client) {
        this.dispatchConnectionEvent(connectionId, event, payload);
      }
    });
  }

  private setScopeLocal(scope: string): void {
    this.releaseScopeRemote(scope);
    this.bindings.set(scope, LOCAL_CONNECTION_ID);
  }

  private releaseScopeRemote(scope: string): void {
    const connectionId = this.bindings.get(scope);
    if (!connectionId || connectionId === LOCAL_CONNECTION_ID) return;
    const remote = this.remoteConnections.get(connectionId);
    if (!remote) return;
    remote.scopes.delete(scope);
    if (remote.scopes.size > 0) return;
    remote.client.stopListening();
    this.remoteConnections.delete(connectionId);
  }

  private remoteForScope(scope: string): RemoteConnection | null {
    const connectionId = this.connectionIdForScope(scope);
    return connectionId === LOCAL_CONNECTION_ID
      ? null
      : (this.remoteConnections.get(connectionId) ?? null);
  }

  private connectionIdForScope(scope: string): string {
    return (
      this.bindings.get(scope) ??
      (scope === DEFAULT_CONNECTION_SCOPE ? this.stored.activeConnectionId : LOCAL_CONNECTION_ID)
    );
  }

  private replaceRemoteConnection(record: StoredDesktopConnection, token: string): void {
    const previous = this.remoteConnections.get(record.id);
    if (!previous) return;
    const scopes = Array.from(previous.scopes);
    previous.client.stopListening();
    this.remoteConnections.delete(record.id);
    const client = new BackendHttpClient(record.address, token);
    for (const [index, scope] of scopes.entries()) {
      if (index === 0) this.setScopeRemote(scope, record, client, token);
      else {
        const remote = this.remoteConnections.get(record.id);
        remote?.scopes.add(scope);
        this.bindings.set(scope, record.id);
      }
    }
  }

  private dispatchConnectionEvent(connectionId: string, event: string, payload: unknown): void {
    this.onConnectionEvent?.(connectionId, event, payload);
    if (this.connectionIdForScope(DEFAULT_CONNECTION_SCOPE) === connectionId) {
      this.onEvent(event, payload);
    }
  }

  private async detectSecureStorage(): Promise<boolean> {
    if (!(await this.secureStorage.isAsyncEncryptionAvailable())) return false;
    return (
      this.platform !== "linux" || this.secureStorage.getSelectedStorageBackend?.() !== "basic_text"
    );
  }

  private async checkRemote(
    address: string,
    token: string,
    timeoutMs = this.connectionTimeoutMs,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(new URL("/__orkestrator/status", address), {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (response.status === 401) throw new Error("The gateway token was rejected.");
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error ?? `Backend check failed with HTTP ${response.status}.`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const seconds = timeoutMs / 1_000;
        throw new Error(
          `The backend did not respond within ${seconds} second${seconds === 1 ? "" : "s"}.`,
        );
      }
      if (error instanceof TypeError) {
        throw new Error(
          "Could not reach the backend. Check its HTTPS address and Tailscale connection.",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private replaceStoredRecord(record: StoredDesktopConnection): StoredDesktopConnections {
    return {
      activeConnectionId: this.stored.activeConnectionId,
      connections: this.stored.connections.map((connection) =>
        connection.id === record.id ? record : connection,
      ),
    };
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async persist(stored: StoredDesktopConnections): Promise<void> {
    // The in-memory catalogue keeps remote windows usable if the owned local
    // backend exits. These mutations last for this Electron process only; a
    // healthy local backend remains the durable writer.
    if (!this.localBackendAvailable) return;
    await this.localBackend.invoke("save_desktop_connections", {
      desktopConnections: parseStoredDesktopConnections(stored),
    });
  }
}
