import { randomUUID } from "node:crypto";
import {
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
  connectionTimeoutMs?: number;
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
  private readonly connectionTimeoutMs: number;
  private stored: StoredDesktopConnections = { activeConnectionId: LOCAL_CONNECTION_ID, connections: [] };
  private activeRemote: { record: StoredDesktopConnection; client: BackendHttpClient; token: string } | null = null;
  private secureStorageAvailable = false;
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
  }

  async initialize(): Promise<void> {
    this.secureStorageAvailable = await this.detectSecureStorage();
    this.stored = parseStoredDesktopConnections(
      await this.localBackend.invoke<StoredDesktopConnections>("get_desktop_connections"),
    );
    if (this.stored.activeConnectionId === LOCAL_CONNECTION_ID) return;
    try {
      await this.activateRemote(this.stored.activeConnectionId, false);
    } catch (error) {
      console.warn("[Connections] Could not restore the previous remote connection; using Local:", error);
      const fallback = { ...this.stored, activeConnectionId: LOCAL_CONNECTION_ID };
      await this.persist(fallback);
      this.stored = fallback;
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
    return this.enqueueMutation(async () => {
      const address = normalizeRemoteAddress(input.address);
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
        connections: [record, ...this.stored.connections.filter((connection) => connection.id !== record.id)],
      };
      await this.persist(candidate);
      this.stored = candidate;
      this.setActiveRemote(record, client, token);
      return this.getList();
    });
  }

  async use(connectionId: string): Promise<ConnectionList> {
    return this.enqueueMutation(async () => {
      if (connectionId === LOCAL_CONNECTION_ID) {
        const candidate = { ...this.stored, activeConnectionId: LOCAL_CONNECTION_ID };
        await this.persist(candidate);
        this.stored = candidate;
        this.activeRemote?.client.stopListening();
        this.activeRemote = null;
        return this.getList();
      }
      await this.activateRemote(connectionId, true);
      return this.getList();
    });
  }

  async forget(connectionId: string): Promise<ConnectionList> {
    return this.enqueueMutation(async () => {
      if (connectionId === LOCAL_CONNECTION_ID) throw new Error("The Local connection cannot be removed.");
      if (!this.stored.connections.some((connection) => connection.id === connectionId)) {
        throw new Error("That saved connection no longer exists.");
      }
      const forgettingActive = this.activeRemote?.record.id === connectionId;
      const candidate: StoredDesktopConnections = {
        activeConnectionId: forgettingActive ? LOCAL_CONNECTION_ID : this.stored.activeConnectionId,
        connections: this.stored.connections.filter((connection) => connection.id !== connectionId),
      };
      await this.persist(candidate);
      this.stored = candidate;
      if (forgettingActive) {
        this.activeRemote?.client.stopListening();
        this.activeRemote = null;
      }
      return this.getList();
    });
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
    return this.enqueueMutation(async () => {
      const target = this.activeRemote;
      const settings = await (target?.client ?? this.localBackend).setToken(token);
      if (!target) return settings;

      target.token = settings.token;
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
        target.record = record;
      } catch (error) {
        const sessionRecord = { ...target.record, encryptedToken: "" };
        this.stored = this.replaceStoredRecord(sessionRecord);
        target.record = sessionRecord;
        throw error;
      }
      return settings;
    });
  }

  setToken(token: string): Promise<GatewayTokenSettings> {
    return this.setGatewayToken(token);
  }

  private currentBackend(): LocalBackend {
    return this.activeRemote?.client ?? this.localBackend;
  }

  private async activateRemote(connectionId: string, updateLastConnected: boolean): Promise<void> {
    const storedRecord = this.stored.connections.find((connection) => connection.id === connectionId);
    if (!storedRecord) throw new Error("That saved connection no longer exists.");
    if (!storedRecord.encryptedToken) throw new Error("Enter the gateway token to reconnect to this server.");
    this.secureStorageAvailable = await this.detectSecureStorage();
    if (!this.secureStorageAvailable) {
      throw new Error("Secure credential storage is unavailable. Enter the gateway token again.");
    }
    const decrypted = await this.secureStorage.decryptStringAsync(Buffer.from(storedRecord.encryptedToken, "base64"));
    const token = normalizeGatewayToken(decrypted.result);
    const client = new BackendHttpClient(storedRecord.address, token);
    await this.checkRemote(storedRecord.address, token);
    const record = { ...storedRecord };
    if (decrypted.shouldReEncrypt) {
      record.encryptedToken = (await this.secureStorage.encryptStringAsync(token)).toString("base64");
    }
    if (updateLastConnected) record.lastConnectedAt = new Date().toISOString();
    const candidate: StoredDesktopConnections = {
      activeConnectionId: record.id,
      connections: this.stored.connections.map((connection) => connection.id === record.id ? record : connection),
    };
    await this.persist(candidate);
    this.stored = candidate;
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
    const timeout = setTimeout(() => controller.abort(), this.connectionTimeoutMs);
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
        const seconds = this.connectionTimeoutMs / 1_000;
        throw new Error(`The backend did not respond within ${seconds} second${seconds === 1 ? "" : "s"}.`);
      }
      if (error instanceof TypeError) {
        throw new Error("Could not reach the backend. Check its HTTPS address and Tailscale connection.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private replaceStoredRecord(record: StoredDesktopConnection): StoredDesktopConnections {
    return {
      activeConnectionId: record.id,
      connections: this.stored.connections.map((connection) => connection.id === record.id ? record : connection),
    };
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async persist(stored: StoredDesktopConnections): Promise<void> {
    await this.localBackend.invoke("save_desktop_connections", {
      desktopConnections: parseStoredDesktopConnections(stored),
    });
  }
}
