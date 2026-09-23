import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";

import type {
  BrowserPreviewServiceTarget,
  BrowserPreviewTransportState,
} from "@orkestrator/protocol/browser-preview";
import {
  PREVIEW_INGRESS_HEADER,
  type PreviewAttachmentDescriptor,
} from "@orkestrator/protocol/preview-access";
import {
  DEFAULT_PREVIEW_FORWARD_LIMITS,
  forwardPreviewRequest,
  forwardPreviewUpgrade,
  rejectPreviewUpgrade,
  writePreviewError,
} from "@orkestrator/protocol/preview-forward";
import type { PreviewHeaderPolicy } from "@orkestrator/protocol/preview-header-policy";
import {
  isOpaquePreviewId,
  normalizePreviewPath,
  previewErrorFromUnknown,
  previewFailure,
  type PreviewError,
} from "@orkestrator/protocol/preview-services";

import { openPreviewTunnel } from "./preview-tunnel-client.js";

/** Minimal Electron Session surface used for service partitions (injectable in tests). */
export interface PreviewServiceSession {
  webRequest: {
    onBeforeSendHeaders(
      listener: (
        details: { url: string; requestHeaders: Record<string, string> },
        callback: (response: { requestHeaders?: Record<string, string>; cancel?: boolean }) => void,
      ) => void,
    ): void;
    onBeforeRequest(
      listener: (
        details: { url: string },
        callback: (response: { cancel?: boolean }) => void,
      ) => void,
    ): void;
  };
  clearStorageData(options?: { storages?: string[] }): Promise<void>;
  clearCache?(): Promise<void>;
}

export interface PreviewPortHints {
  get(key: string): number | undefined;
  set(key: string, port: number): void;
}

export interface PreviewTransportManagerOptions {
  /** Invoke a backend command on this window's connection. */
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  /** Tunnel URL for this window's connection, or null when unavailable. */
  tunnelUrl: () => string | null;
  /** Remote backends must never fall back to client-local services. */
  isRemote: () => boolean;
  partitionFor: (target: { backendInstanceId: string; serviceId: string }) => string;
  sessionFor: (partition: string) => PreviewServiceSession;
  /** Non-secret per-window key for backend admission accounting. */
  clientKey: string;
  portHints?: PreviewPortHints;
  retirementMs?: number;
  renewIntervalMs?: number;
  /** Idle pooled upstream connections are dropped after this long. */
  poolIdleMs?: number;
  poolMax?: number;
  onStateChange?: (serviceKey: string) => void;
  logger?: Pick<Console, "warn">;
}

export interface PreviewTransportDescriptor {
  serviceKey: string;
  partition: string;
  origin: string;
  url: string;
  applicationPort: number;
}

interface ServiceGroup {
  key: string;
  target: Omit<BrowserPreviewServiceTarget, "path">;
  partition: string;
  holders: Set<string>;
  attachment: PreviewAttachmentDescriptor | null;
  attaching: Promise<PreviewAttachmentDescriptor> | null;
  server: Server | null;
  port: number;
  origin: string;
  ingressSecret: string;
  sockets: Set<Socket>;
  pool: Array<{ socket: Duplex; idle: ReturnType<typeof setTimeout> }>;
  retireTimer: ReturnType<typeof setTimeout> | null;
  renewTimer: ReturnType<typeof setInterval> | null;
  state: BrowserPreviewTransportState;
  ready: Promise<void>;
  disposed: boolean;
}

const LOOPBACK_OR_PRIVATE = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /\.localhost$/i,
];

function isLocalNetworkHost(hostname: string): boolean {
  return LOOPBACK_OR_PRIVATE.some((pattern) => pattern.test(hostname));
}

function sameSecret(expected: string, candidate: string | undefined): boolean {
  if (typeof candidate !== "string" || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

export function previewServiceKey(target: {
  backendInstanceId: string;
  serviceId: string;
}): string {
  return `${target.backendInstanceId}:${target.serviceId}`;
}

/**
 * Owns desktop preview transport for one window's connection: per-service
 * loopback ingress listeners, scoped backend attachments, pooled tunnel
 * connections, and the service partitions' request hooks. It is reference
 * counted by explicit holders (tabs), not by mounted React components: hiding
 * a view never closes a listener, and the application keeps running.
 */
export class PreviewTransportManager {
  private readonly groups = new Map<string, ServiceGroup>();
  private readonly partitions = new Map<string, ServiceGroup>();
  private readonly hookedSessions = new WeakSet<object>();
  private disposed = false;

  constructor(private readonly options: PreviewTransportManagerOptions) {}

  // -------------------------------------------------------------------------
  // Attachment by holders

  async acquire(
    target: BrowserPreviewServiceTarget,
    holderId: string,
  ): Promise<PreviewTransportDescriptor> {
    if (this.disposed) throw previewFailure("backend-unavailable");
    if (!isOpaquePreviewId(target.serviceId) || !isOpaquePreviewId(target.backendInstanceId)) {
      throw previewFailure("invalid-request", { message: "Invalid service reference." });
    }
    const path = normalizePreviewPath(target.path);
    const key = previewServiceKey(target);
    let group = this.groups.get(key);
    if (group && group.target.environmentId !== target.environmentId) {
      throw previewFailure("not-found", {
        message: "The service belongs to a different environment.",
      });
    }
    if (!group) {
      group = this.createGroup(key, target);
      this.groups.set(key, group);
    }
    group.holders.add(holderId);
    if (group.retireTimer) {
      clearTimeout(group.retireTimer);
      group.retireTimer = null;
    }
    try {
      await group.ready;
    } catch (error) {
      group.holders.delete(holderId);
      if (group.holders.size === 0) void this.retire(group);
      throw error;
    }
    return {
      serviceKey: key,
      partition: group.partition,
      origin: group.origin,
      url: `${group.origin}${path}`,
      applicationPort: group.attachment?.applicationPort ?? 0,
    };
  }

  /** Release one holder. The listener idles out after a short retirement lease. */
  release(serviceKey: string, holderId: string): void {
    const group = this.groups.get(serviceKey);
    if (!group) return;
    group.holders.delete(holderId);
    if (group.holders.size > 0 || group.retireTimer) return;
    group.retireTimer = setTimeout(
      () => void this.retire(group),
      this.options.retirementMs ?? 30_000,
    );
    group.retireTimer.unref?.();
  }

  /** Navigation scope for an ingress URL, so the view manager can confine navigation. */
  scopeFor(url: string): string | null {
    const group = this.groupForUrl(url);
    return group ? `service:${group.key}` : null;
  }

  /** Map a view URL back to its service identity and application address. */
  describe(
    url: string,
  ): { serviceKey: string; serviceId: string; path: string; displayUrl: string } | null {
    const group = this.groupForUrl(url);
    if (!group) return null;
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    const port = group.attachment?.applicationPort;
    return {
      serviceKey: group.key,
      serviceId: group.target.serviceId,
      path,
      displayUrl: port ? `http://localhost:${port}${path}` : path,
    };
  }

  target(serviceKey: string): Omit<BrowserPreviewServiceTarget, "path"> | null {
    return this.groups.get(serviceKey)?.target ?? null;
  }

  transportState(serviceKey: string): BrowserPreviewTransportState {
    return (
      this.groups.get(serviceKey)?.state ?? {
        mode: "desktop-tunnel",
        state: "unavailable",
        failure: "not-found",
      }
    );
  }

  /** Clear one service's site data. Never touches control or other services' storage. */
  async resetSiteData(
    target: Pick<BrowserPreviewServiceTarget, "backendInstanceId" | "serviceId">,
  ): Promise<void> {
    const session = this.options.sessionFor(this.options.partitionFor(target));
    await session.clearStorageData();
    await session.clearCache?.();
  }

  stats() {
    let sockets = 0;
    let pooled = 0;
    for (const group of this.groups.values()) {
      sockets += group.sockets.size;
      pooled += group.pool.length;
    }
    return { services: this.groups.size, ingressSockets: sockets, pooledUpstreams: pooled };
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    await Promise.all(Array.from(this.groups.values()).map((group) => this.retire(group)));
  }

  // -------------------------------------------------------------------------
  // Groups

  private groupForUrl(url: string): ServiceGroup | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const origin = parsed.protocol === "ws:" ? `http://${parsed.host}` : parsed.origin;
    for (const group of this.groups.values()) {
      if (group.origin === origin && !group.disposed) return group;
    }
    return null;
  }

  private createGroup(key: string, target: BrowserPreviewServiceTarget): ServiceGroup {
    const group: ServiceGroup = {
      key,
      target: {
        backendInstanceId: target.backendInstanceId,
        environmentId: target.environmentId,
        serviceId: target.serviceId,
      },
      partition: this.options.partitionFor(target),
      holders: new Set(),
      attachment: null,
      attaching: null,
      server: null,
      port: 0,
      origin: "",
      ingressSecret: randomBytes(32).toString("base64url"),
      sockets: new Set(),
      pool: [],
      retireTimer: null,
      renewTimer: null,
      state: { mode: "desktop-tunnel", state: "connecting" },
      ready: Promise.resolve(),
      disposed: false,
    };
    group.ready = this.start(group);
    // Rejections are reported to acquirers; never leave this promise unowned.
    group.ready.catch(() => undefined);
    return group;
  }

  private async start(group: ServiceGroup): Promise<void> {
    try {
      await this.attach(group);
      await this.listen(group);
      this.installSessionHooks(group);
      group.renewTimer = setInterval(
        () => void this.renew(group),
        this.options.renewIntervalMs ?? 5 * 60_000,
      );
      group.renewTimer.unref?.();
      this.setState(group, { mode: "desktop-tunnel", state: "ready" });
    } catch (error) {
      const failure = previewErrorFromUnknown(error);
      this.setState(group, {
        mode: "desktop-tunnel",
        state: "unavailable",
        failure: failure?.category ?? "internal",
        message: failure?.message,
      });
      this.groups.delete(group.key);
      await this.closeGroup(group);
      throw error;
    }
  }

  private attach(group: ServiceGroup): Promise<PreviewAttachmentDescriptor> {
    group.attaching ??= (async () => {
      const previous = group.attachment;
      const attachment = await this.options.invoke<PreviewAttachmentDescriptor>(
        "create_preview_attachment",
        {
          serviceId: group.target.serviceId,
          surface: "desktop-tunnel",
          clientKey: this.options.clientKey,
        },
      );
      if (
        attachment.backendInstanceId !== group.target.backendInstanceId ||
        attachment.environmentId !== group.target.environmentId ||
        !attachment.tunnel
      ) {
        throw previewFailure("not-found", {
          message: "The service belongs to a different backend.",
        });
      }
      group.attachment = attachment;
      // Pooled connections belong to the old attachment and generation.
      this.drainPool(group);
      if (previous) {
        void this.options
          .invoke("release_preview_attachment", { attachmentId: previous.attachmentId })
          .catch(() => undefined);
      }
      return attachment;
    })().finally(() => {
      group.attaching = null;
    });
    return group.attaching;
  }

  private async renew(group: ServiceGroup): Promise<void> {
    const attachment = group.attachment;
    if (!attachment || group.disposed) return;
    try {
      await this.options.invoke("renew_preview_attachment", {
        attachmentId: attachment.attachmentId,
      });
    } catch (error) {
      const category = previewErrorFromUnknown(error)?.category;
      if (
        category === "access-expired" ||
        category === "not-found" ||
        category === "generation-changed"
      ) {
        this.setState(group, { mode: "desktop-tunnel", state: "reconnecting" });
        await this.attach(group)
          .then(() => this.setState(group, { mode: "desktop-tunnel", state: "ready" }))
          .catch((failure: unknown) => {
            const preview = previewErrorFromUnknown(failure);
            this.setState(group, {
              mode: "desktop-tunnel",
              state: "unavailable",
              failure: preview?.category ?? "internal",
              message: preview?.message,
            });
          });
      }
    }
  }

  private setState(group: ServiceGroup, state: BrowserPreviewTransportState): void {
    group.state = state;
    this.options.onStateChange?.(group.key);
  }

  private async listen(group: ServiceGroup): Promise<void> {
    const server = createServer(
      (request, response) => void this.handleRequest(group, request, response),
    );
    server.on(
      "upgrade",
      (request: IncomingMessage, socket: Socket, head: Buffer) =>
        void this.handleUpgrade(group, request, socket, head),
    );
    server.on("connection", (socket: Socket) => {
      group.sockets.add(socket);
      socket.once("close", () => group.sockets.delete(socket));
    });
    server.maxConnections = 128;
    server.headersTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    const hint = this.options.portHints?.get(group.key);
    // Bind the remembered port directly (never probe-then-close); fall back to
    // an OS-assigned port if it is taken. The bound socket is kept.
    const bind = (port: number) =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
    try {
      await bind(hint ?? 0);
    } catch (error) {
      if (!hint) throw error;
      await bind(0);
    }
    group.server = server;
    group.port = (server.address() as AddressInfo).port;
    group.origin = `http://127.0.0.1:${group.port}`;
    this.options.portHints?.set(group.key, group.port);
  }

  private policy(group: ServiceGroup): PreviewHeaderPolicy {
    const port = group.attachment?.applicationPort ?? 0;
    return {
      privateAuthority: `localhost:${port}`,
      privateOrigins: [
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
        `http://[::1]:${port}`,
      ],
      publicOrigin: group.origin,
      stripRequestHeaders: [PREVIEW_INGRESS_HEADER],
    };
  }

  /**
   * Local ingress is credentialed: port secrecy is not authentication. The
   * header is injected by main only for this service's own partition and
   * origin. The Host check defeats DNS-rebinding requests from other sites.
   */
  private authorizeIngress(
    group: ServiceGroup,
    request: IncomingMessage,
  ): PreviewError["category"] | null {
    const host = request.headers.host;
    if (host !== `127.0.0.1:${group.port}`) return "forbidden";
    const credential = request.headers[PREVIEW_INGRESS_HEADER];
    if (!sameSecret(group.ingressSecret, Array.isArray(credential) ? undefined : credential))
      return "forbidden";
    if (group.disposed || !group.attachment) return "backend-unavailable";
    return null;
  }

  private async handleRequest(
    group: ServiceGroup,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const denied = this.authorizeIngress(group, request);
    if (denied) {
      writePreviewError(response, denied);
      return;
    }
    await forwardPreviewRequest(
      request,
      response,
      this.policy(group),
      DEFAULT_PREVIEW_FORWARD_LIMITS,
      {
        connect: (signal) => this.connect(group, signal),
        reuse: (socket) => this.pool(group, socket),
      },
    ).catch(() => {
      writePreviewError(response, "internal");
    });
  }

  private async handleUpgrade(
    group: ServiceGroup,
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    socket.on("error", () => undefined);
    const denied = this.authorizeIngress(group, request);
    if (denied) {
      rejectPreviewUpgrade(socket, denied);
      return;
    }
    await forwardPreviewUpgrade(
      request,
      socket,
      head,
      this.policy(group),
      DEFAULT_PREVIEW_FORWARD_LIMITS,
      {
        connect: (signal) => this.connect(group, signal, false),
      },
    ).catch(() => rejectPreviewUpgrade(socket, "internal"));
  }

  /**
   * Open (or reuse) an upstream connection through the tunnel. A connection
   * refused because access expired or the endpoint generation moved is
   * retried once with a fresh attachment — no application bytes have been sent
   * at that point, so this re-establishes transport, not an application write.
   */
  private async connect(
    group: ServiceGroup,
    signal: AbortSignal,
    allowPooled = true,
  ): Promise<Duplex> {
    if (allowPooled) {
      while (group.pool.length) {
        const entry = group.pool.pop()!;
        clearTimeout(entry.idle);
        if (!entry.socket.destroyed && entry.socket.writable && entry.socket.readable) {
          entry.socket.resume();
          return entry.socket;
        }
      }
    }
    const url = this.options.tunnelUrl();
    if (!url) throw previewFailure("backend-unavailable");
    const open = async () => {
      const attachment = group.attachment ?? (await this.attach(group));
      return openPreviewTunnel({
        url,
        attachmentId: attachment.attachmentId,
        credential: attachment.tunnel!.credential,
        signal,
      });
    };
    try {
      return await open();
    } catch (error) {
      const category = previewErrorFromUnknown(error)?.category;
      if (signal.aborted || (category !== "access-expired" && category !== "generation-changed"))
        throw error;
      this.setState(group, { mode: "desktop-tunnel", state: "reconnecting" });
      await this.attach(group);
      this.setState(group, { mode: "desktop-tunnel", state: "ready" });
      return open();
    }
  }

  private pool(group: ServiceGroup, socket: Duplex): void {
    if (group.disposed || group.pool.length >= (this.options.poolMax ?? 6)) {
      socket.destroy();
      return;
    }
    const entry = {
      socket,
      idle: setTimeout(() => {
        const index = group.pool.indexOf(entry);
        if (index >= 0) group.pool.splice(index, 1);
        socket.destroy();
      }, this.options.poolIdleMs ?? 2_000),
    };
    entry.idle.unref?.();
    socket.once("close", () => {
      clearTimeout(entry.idle);
      const index = group.pool.indexOf(entry);
      if (index >= 0) group.pool.splice(index, 1);
    });
    group.pool.push(entry);
  }

  private drainPool(group: ServiceGroup): void {
    for (const entry of group.pool.splice(0)) {
      clearTimeout(entry.idle);
      entry.socket.destroy();
    }
  }

  /**
   * Partition hooks. Electron allows one listener per webRequest event per
   * session, so they are installed once per partition and look the owning
   * group up at request time.
   */
  private installSessionHooks(group: ServiceGroup): void {
    this.partitions.set(group.partition, group);
    const session = this.options.sessionFor(group.partition);
    if (this.hookedSessions.has(session)) return;
    this.hookedSessions.add(session);
    const partition = group.partition;
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const owner = this.partitions.get(partition);
      const headers = { ...details.requestHeaders };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === PREVIEW_INGRESS_HEADER) delete headers[name];
      }
      try {
        const url = new URL(details.url);
        const origin = url.protocol === "ws:" ? `http://${url.host}` : url.origin;
        if (owner && !owner.disposed && origin === owner.origin)
          headers[PREVIEW_INGRESS_HEADER] = owner.ingressSecret;
      } catch {
        // Unparseable URLs get no credential.
      }
      callback({ requestHeaders: headers });
    });
    session.webRequest.onBeforeRequest((details, callback) => {
      const owner = this.partitions.get(partition);
      let url: URL;
      try {
        url = new URL(details.url);
      } catch {
        callback({});
        return;
      }
      const origin = url.protocol === "ws:" ? `http://${url.host}` : url.origin;
      if (owner && origin === owner.origin) {
        callback({});
        return;
      }
      // A remote service must never silently reach a service on this machine
      // or its local network: that would bypass the remote transport.
      const network = /^(https?|wss?):$/.test(url.protocol);
      if (network && this.options.isRemote() && isLocalNetworkHost(url.hostname)) {
        callback({ cancel: true });
        return;
      }
      callback({});
    });
  }

  private async retire(group: ServiceGroup): Promise<void> {
    if (group.disposed) return;
    this.groups.delete(group.key);
    if (this.partitions.get(group.partition) === group) this.partitions.delete(group.partition);
    await this.closeGroup(group);
    const attachment = group.attachment;
    if (attachment) {
      await this.options
        .invoke("release_preview_attachment", { attachmentId: attachment.attachmentId })
        .catch(() => undefined);
    }
  }

  private async closeGroup(group: ServiceGroup): Promise<void> {
    group.disposed = true;
    if (group.retireTimer) clearTimeout(group.retireTimer);
    if (group.renewTimer) clearInterval(group.renewTimer);
    this.drainPool(group);
    const server = group.server;
    group.server = null;
    for (const socket of Array.from(group.sockets)) socket.destroy();
    if (server) {
      await new Promise<void>((resolve) => {
        const fallback = setTimeout(resolve, 250);
        fallback.unref?.();
        server.close(() => {
          clearTimeout(fallback);
          resolve();
        });
        server.closeAllConnections?.();
      });
    }
  }
}

/** Stable, non-sensitive partition suffix for a service. */
export function previewServicePartitionSuffix(target: {
  backendInstanceId: string;
  serviceId: string;
}): string {
  return createHash("sha256")
    .update(`${target.backendInstanceId}:${target.serviceId}`)
    .digest("hex")
    .slice(0, 16);
}
