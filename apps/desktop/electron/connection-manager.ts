import { randomUUID } from "node:crypto";
import {
  LOCAL_CONNECTION_ID,
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
  "invoke" | "getWebClientStatus" | "setWebClientEnabled" | "getTokenSettings" | "setToken"
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
  onEvent: (event: string, payload: unknown) => void;
};

const CONNECTION_TIMEOUT_MS = 10_000;

function normalizeRemoteAddress(value: string): string {
  const candidate = value.trim();
  if (!candidate) throw new Error("Enter the backend address.");

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
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
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
  private stored: StoredDesktopConnections = { activeConnectionId: LOCAL_CONNECTION_ID, connections: [] };
  private activeRemote: { record: StoredDesktopConnection; client: BackendHttpClient; token: string } | null = null;
  private secureStorageAvailable = false;

  constructor(options: ConnectionManagerOptions) {
    this.localBackend = options.localBackend;
    this.secureStorage = options.secureStorage;
    this.platform = options.platform ?? process.platform;
    this.onEvent = options.onEvent;
  }

  async initialize(): Promise<void> {
    this.secureStorageAvailable = await this.detectSecureStorage();
    this.stored = await this.localBackend.invoke<StoredDesktopConnections>("get_desktop_connections");
    if (this.stored.activeConnectionId === LOCAL_CONNECTION_ID) return;
    try {
      await this.activateRemote(this.stored.activeConnectionId, false);
    } catch (error) {
      console.warn("[Connections] Could not restore the previous remote connection; using Local:", error);
      this.stored.activeConnectionId = LOCAL_CONNECTION_ID;
      await this.persist();
    }
  }

  getList(): ConnectionList {
    const activeConnectionId = this.activeRemote?.record.id ?? LOCAL_CONNECTION_ID;
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
          requiresToken: connection.id !== activeConnectionId && !connection.encryptedToken,
          lastConnectedAt: connection.lastConnectedAt,
        })),
      ],
    };
  }

  async connect(input: ConnectToRemoteInput): Promise<ConnectionList> {
    const address = normalizeRemoteAddress(input.address);
    const token = normalizeGatewayToken(input.token);
    this.secureStorageAvailable = await this.detectSecureStorage();

    const client = new BackendHttpClient(address, token);
    await this.checkRemote(address, token);
    const encryptedToken = this.secureStorageAvailable
      ? (await this.secureStorage.encryptStringAsync(token)).toString("base64")
      : "";
    const now = new Date().toISOString();
    const existing = this.stored.connections.find((connection) => connection.address === address);
    const record: StoredDesktopConnection = {
      id: existing?.id ?? randomUUID(),
      name: connectionName(address),
      address,
      encryptedToken,
      lastConnectedAt: now,
    };
    this.stored.connections = [record, ...this.stored.connections.filter((connection) => connection.id !== record.id)];
    this.stored.activeConnectionId = record.id;
    await this.persist();
    this.setActiveRemote(record, client, token);
    return this.getList();
  }

  async use(connectionId: string): Promise<ConnectionList> {
    if (connectionId === LOCAL_CONNECTION_ID) {
      this.activeRemote?.client.stopListening();
      this.activeRemote = null;
      this.stored.activeConnectionId = LOCAL_CONNECTION_ID;
      await this.persist();
      return this.getList();
    }
    await this.activateRemote(connectionId, true);
    return this.getList();
  }

  async forget(connectionId: string): Promise<ConnectionList> {
    if (connectionId === LOCAL_CONNECTION_ID) throw new Error("The Local connection cannot be removed.");
    if (this.activeRemote?.record.id === connectionId) {
      this.activeRemote.client.stopListening();
      this.activeRemote = null;
      this.stored.activeConnectionId = LOCAL_CONNECTION_ID;
    }
    this.stored.connections = this.stored.connections.filter((connection) => connection.id !== connectionId);
    await this.persist();
    return this.getList();
  }

  invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.currentBackend().invoke<T>(command, args);
  }

  handleLocalEvent(event: string, payload: unknown): void {
    if (!this.activeRemote) this.onEvent(event, payload);
  }

  getRendererRequestAuthorization(urlValue: string): string | null {
    if (!this.activeRemote) return null;
    try {
      const url = new URL(urlValue);
      if (url.origin !== this.activeRemote.record.address || !url.pathname.startsWith("/__orkestrator/")) {
        return null;
      }
      return `Bearer ${this.activeRemote.token}`;
    } catch {
      return null;
    }
  }

  getWebClientStatus(): Promise<WebClientStatus> {
    return this.currentBackend().getWebClientStatus();
  }

  setWebClientEnabled(enabled: boolean): Promise<WebClientStatus> {
    return this.currentBackend().setWebClientEnabled(enabled);
  }

  getGatewayTokenSettings(): Promise<GatewayTokenSettings> {
    return this.currentBackend().getTokenSettings();
  }

  getTokenSettings(): Promise<GatewayTokenSettings> {
    return this.getGatewayTokenSettings();
  }

  async setGatewayToken(token: string): Promise<GatewayTokenSettings> {
    const settings = await this.currentBackend().setToken(token);
    if (this.activeRemote) {
      this.activeRemote.token = settings.token;
      this.secureStorageAvailable = await this.detectSecureStorage();
      this.activeRemote.record.encryptedToken = this.secureStorageAvailable
        ? (await this.secureStorage.encryptStringAsync(settings.token)).toString("base64")
        : "";
      await this.persist();
    }
    return settings;
  }

  setToken(token: string): Promise<GatewayTokenSettings> {
    return this.setGatewayToken(token);
  }

  private currentBackend(): LocalBackend {
    return this.activeRemote?.client ?? this.localBackend;
  }

  private async activateRemote(connectionId: string, updateLastConnected: boolean): Promise<void> {
    const record = this.stored.connections.find((connection) => connection.id === connectionId);
    if (!record) throw new Error("That saved connection no longer exists.");
    if (!record.encryptedToken) throw new Error("Enter the gateway token to reconnect to this server.");
    this.secureStorageAvailable = await this.detectSecureStorage();
    if (!this.secureStorageAvailable) {
      throw new Error("Secure credential storage is unavailable. Enter the gateway token again.");
    }
    const decrypted = await this.secureStorage.decryptStringAsync(Buffer.from(record.encryptedToken, "base64"));
    const token = normalizeGatewayToken(decrypted.result);
    const client = new BackendHttpClient(record.address, token);
    await this.checkRemote(record.address, token);
    if (decrypted.shouldReEncrypt) {
      record.encryptedToken = (await this.secureStorage.encryptStringAsync(token)).toString("base64");
    }
    if (updateLastConnected) record.lastConnectedAt = new Date().toISOString();
    this.stored.activeConnectionId = record.id;
    await this.persist();
    this.setActiveRemote(record, client, token);
  }

  private setActiveRemote(record: StoredDesktopConnection, client: BackendHttpClient, token: string): void {
    this.activeRemote?.client.stopListening();
    this.activeRemote = { record, client, token };
    client.listen((event, payload) => {
      if (this.activeRemote?.client === client) this.onEvent(event, payload);
    });
  }

  private async detectSecureStorage(): Promise<boolean> {
    if (!await this.secureStorage.isAsyncEncryptionAvailable()) return false;
    return this.platform !== "linux" || this.secureStorage.getSelectedStorageBackend?.() !== "basic_text";
  }

  private async checkRemote(address: string, token: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
    try {
      const response = await fetch(new URL("/__orkestrator/status", address), {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (response.status === 401) throw new Error("The gateway token was rejected.");
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error ?? `Backend check failed with HTTP ${response.status}.`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("The backend did not respond within 10 seconds.");
      }
      if (error instanceof TypeError) {
        throw new Error("Could not reach the backend. Check its HTTPS address and Tailscale connection.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async persist(): Promise<void> {
    await this.localBackend.invoke("save_desktop_connections", { desktopConnections: this.stored });
  }
}
