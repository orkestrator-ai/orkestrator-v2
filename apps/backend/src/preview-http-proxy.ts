import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  DEFAULT_PREVIEW_FORWARD_LIMITS,
  forwardPreviewRequest,
  forwardPreviewUpgrade,
  rejectPreviewUpgrade,
  writePreviewError,
  type PreviewForwardLimits,
} from "@orkestrator/protocol/preview-forward";
import type { PreviewHeaderPolicy } from "@orkestrator/protocol/preview-header-policy";
import {
  previewErrorFromUnknown,
  type PreviewServiceDefinition,
} from "@orkestrator/protocol/preview-services";

import type { AuthenticatedPreviewAccess } from "./core/preview-access.js";
import type { PreviewRuntime } from "./core/preview-runtime.js";
import { PreviewAdmission } from "./preview-admission.js";
import type { PreviewMetrics } from "./preview-metrics.js";
import { connectPreviewUpstream, type PreviewUpstreamOptions } from "./preview-upstream.js";

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
    this.upstream = { connectTimeoutMs: limits.connectTimeoutMs, ...options.upstream };
  }

  stats() {
    return { http: this.http.stats(), upgrades: this.upgrades.stats() };
  }

  private definition(context: PreviewProxyContext): PreviewServiceDefinition | null {
    return this.options.runtime.registry.getDefinition(context.access.serviceId);
  }

  private hooks(context: PreviewProxyContext) {
    const { runtime } = this.options;
    return {
      connect: async (signal: AbortSignal): Promise<Duplex> => {
        const started = Date.now();
        runtime.access.assertCurrent(context.access);
        const target = await runtime.registry.acquireTarget(
          context.access.serviceId,
          context.access.generation,
        );
        const socket = await connectPreviewUpstream(target, this.upstream, signal);
        this.options.metrics.observe("http.connect_ms", Date.now() - started);
        return socket;
      },
      track: (close: () => void) => runtime.access.track(context.access, { close }),
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
        this.hooks(context),
      );
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
        this.hooks(context),
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
