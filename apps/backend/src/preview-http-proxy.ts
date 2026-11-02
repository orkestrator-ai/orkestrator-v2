import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  DEFAULT_PREVIEW_FORWARD_LIMITS,
  forwardPreviewRequest,
  forwardPreviewUpgrade,
  rejectPreviewUpgrade,
  writePreviewError,
  type PreviewForwardLimits,
} from "@orkestrator/protocol/node/preview-forward";
import type { PreviewHeaderPolicy } from "@orkestrator/protocol/preview-header-policy";
import {
  previewErrorFromUnknown,
  type PreviewServiceDefinition,
} from "@orkestrator/protocol/preview-services";

import type { AuthenticatedPreviewAccess } from "./core/preview-access.js";
import type { PreviewRuntime } from "./core/preview-runtime.js";
import { PreviewAdmission } from "./preview-admission.js";
import type { PreviewMetrics } from "./preview-metrics.js";
import type { ResolvedPreviewTarget } from "./core/preview-service-registry.js";
import { connectPreviewUpstream, type PreviewUpstreamOptions } from "./preview-upstream.js";
import {
  DEFAULT_PREVIEW_UPSTREAM_POOL_LIMITS,
  PreviewUpstreamPool,
  type PreviewUpstreamPoolLimits,
} from "./preview-upstream-pool.js";

export interface PreviewProxyContext {
  access: AuthenticatedPreviewAccess;
  /** Origin the browser uses for this service (a validated preview host). */
  publicOrigin: string;
  forwardedFor?: string;
}

export interface PreviewHttpProxyOptions {
  runtime: PreviewRuntime;
  metrics: PreviewMetrics;
  upstream?: Partial<PreviewUpstreamOptions>;
  limits?: Partial<PreviewForwardLimits>;
  /** Idle upstream connection bounds; `perAccess: 0` turns reuse off. */
  pool?: Partial<PreviewUpstreamPoolLimits>;
}

export function previewHeaderPolicy(
  definition: Pick<PreviewServiceDefinition, "scheme" | "applicationPort">,
  publicOrigin: string,
  forwardedFor?: string,
): PreviewHeaderPolicy {
  const scheme = definition.scheme;
  const port = definition.applicationPort;
  return {
    privateAuthority: `localhost:${port}`,
    privateOrigins: [
      `${scheme}://localhost:${port}`,
      `${scheme}://127.0.0.1:${port}`,
      `${scheme}://[::1]:${port}`,
    ],
    publicOrigin,
    ...(forwardedFor ? { forwardedFor } : {}),
  };
}

/**
 * Full-origin HTTP/WS forwarding for authorized preview sessions. The request
 * never chooses its destination: the target comes from the session's service
 * and endpoint generation, re-checked immediately before connecting.
 */
export class PreviewHttpProxy {
  readonly http: PreviewAdmission;
  readonly upgrades: PreviewAdmission;
  private readonly limits: PreviewForwardLimits;
  private readonly upstream: PreviewUpstreamOptions;
  private readonly pool: PreviewUpstreamPool | null;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: PreviewHttpProxyOptions) {
    const limits = options.runtime.limits;
    this.http = new PreviewAdmission("http", {
      perService: limits.httpActivePerService,
      perBackend: limits.httpActivePerBackend,
    });
    this.upgrades = new PreviewAdmission("upgrade", {
      perService: limits.upgradesPerService,
      perBackend: limits.upgradesPerBackend,
    });
    this.limits = {
      ...DEFAULT_PREVIEW_FORWARD_LIMITS,
      headersTimeoutMs: limits.responseHeadersTimeoutMs,
      bodyIdleTimeoutMs: limits.bodyIdleTimeoutMs,
      uploadMaxBytes: limits.uploadMaxBytes,
      downloadMaxBytes: limits.downloadMaxBytes,
      headerMaxBytes: limits.headerMaxBytes,
      headerMaxFields: limits.headerMaxFields,
      ...options.limits,
    };
    this.upstream = {
      connectTimeoutMs: limits.connectTimeoutMs,
      relayConnect: (target, signal) => options.runtime.relayConnect(target, signal),
      ...options.upstream,
    };
    const pool = { ...DEFAULT_PREVIEW_UPSTREAM_POOL_LIMITS, ...options.pool };
    this.pool = pool.perAccess > 0 ? new PreviewUpstreamPool(options.runtime.access, pool) : null;
    // Access revocation, expiry and a new endpoint generation reach the pool
    // through access tracking; a registry revocation also drops it directly.
    this.unsubscribe = options.runtime.registry.onRevoked((serviceIds) => {
      for (const serviceId of serviceIds) this.pool?.dropService(serviceId);
    });
  }

  stats() {
    return {
      http: this.http.stats(),
      upgrades: this.upgrades.stats(),
      upstreamPool: this.pool?.stats() ?? null,
    };
  }

  /** Close idle upstream connections; in-flight exchanges belong to their access. */
  dispose(): void {
    this.unsubscribe();
    this.pool?.dispose();
  }

  private definition(context: PreviewProxyContext): PreviewServiceDefinition | null {
    return this.options.runtime.registry.getDefinition(context.access.serviceId);
  }

  /** Re-check the access and resolve its current target before any upstream use. */
  private async authorizedTarget(context: PreviewProxyContext): Promise<ResolvedPreviewTarget> {
    const { runtime } = this.options;
    runtime.access.assertCurrent(context.access);
    return runtime.registry.acquireTarget(context.access.serviceId, context.access.generation);
  }

  private hooks(context: PreviewProxyContext, reusable: boolean) {
    const { runtime, metrics } = this.options;
    // The target this exchange's connection was opened for or taken under.
    let target: ResolvedPreviewTarget | null = null;
    const pool = reusable ? this.pool : null;
    return {
      connect: async (signal: AbortSignal): Promise<Duplex> => {
        const started = Date.now();
        target = await this.authorizedTarget(context);
        const socket = await connectPreviewUpstream(target, this.upstream, signal);
        metrics.observe("http.connect_ms", Date.now() - started);
        metrics.increment("upstream.opened");
        return socket;
      },
      track: (close: () => void) => runtime.access.track(context.access, { close }),
      ...(pool
        ? {
            takeIdle: async (): Promise<Duplex | null> => {
              target = await this.authorizedTarget(context);
              const socket = pool.take(context.access, target);
              if (socket) metrics.increment("upstream.reused");
              return socket;
            },
            reuse: (socket: Duplex) => {
              if (target) pool.put(context.access, target, socket);
              else socket.destroy();
            },
            onStaleRetry: () => metrics.increment("upstream.stale_retry"),
          }
        : {}),
    };
  }

  async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    context: PreviewProxyContext,
  ): Promise<void> {
    const definition = this.definition(context);
    if (!definition) {
      writePreviewError(response, "not-found");
      this.options.metrics.increment("http.rejected", "not-found");
      return;
    }
    const slot = this.http.tryAcquire(definition.serviceId);
    if (!slot) {
      writePreviewError(response, "capacity-exceeded");
      this.options.metrics.increment("http.rejected", "capacity-exceeded");
      return;
    }
    try {
      const result = await forwardPreviewRequest(
        request,
        response,
        previewHeaderPolicy(definition, context.publicOrigin, context.forwardedFor),
        this.limits,
        this.hooks(context, true),
      );
      if (result.firstByteMs !== undefined)
        this.options.metrics.observe("http.first_byte_ms", result.firstByteMs);
      const name =
        result.outcome === "completed"
          ? "http.completed"
          : result.outcome === "client-aborted"
            ? "http.client_aborted"
            : result.outcome === "rejected"
              ? "http.rejected"
              : "http.failed";
      this.options.metrics.increment(name, result.category);
    } catch (error) {
      const category = previewErrorFromUnknown(error)?.category ?? "internal";
      writePreviewError(response, category);
      this.options.metrics.increment("http.failed", category);
    } finally {
      slot.release();
    }
  }

  async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    context: PreviewProxyContext,
  ): Promise<void> {
    const definition = this.definition(context);
    if (!definition) {
      rejectPreviewUpgrade(socket, "not-found");
      return;
    }
    const slot = this.upgrades.tryAcquire(definition.serviceId);
    if (!slot) {
      rejectPreviewUpgrade(socket, "capacity-exceeded");
      this.options.metrics.increment("upgrade.rejected", "capacity-exceeded");
      return;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slot.release();
    };
    try {
      const result = await forwardPreviewUpgrade(
        request,
        socket,
        head,
        previewHeaderPolicy(definition, context.publicOrigin, context.forwardedFor),
        { ...this.limits, headersTimeoutMs: Math.min(this.limits.headersTimeoutMs, 30_000) },
        // An upgraded connection is never returned to the pool.
        this.hooks(context, false),
      );
      this.options.metrics.increment(
        result.outcome === "open"
          ? "upgrade.open"
          : result.outcome === "rejected"
            ? "upgrade.rejected"
            : "upgrade.failed",
        result.category,
      );
      // The slot is held for the upgraded connection's whole life.
      void result.closed.finally(release);
    } catch {
      release();
      rejectPreviewUpgrade(socket, "internal");
    }
  }
}
