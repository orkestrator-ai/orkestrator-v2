import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import {
  PREVIEW_LIMITS,
  type PreviewErrorCategory,
  type PreviewReadiness,
  type PreviewServiceDefinition,
} from "@orkestrator/protocol/preview-services";

import type { PreviewReadinessPort, ResolvedPreviewTarget } from "./preview-service-registry.js";

export interface PreviewReadinessOptions {
  concurrency?: number;
  queueMax?: number;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  /** Extra CA bundle (PEM) for HTTPS upstream verification. */
  ca?: () => string | undefined;
  /** Relay-backed targets are probed through the relay (step 13). */
  relayConnect?: (target: ResolvedPreviewTarget, signal: AbortSignal) => Promise<Socket>;
}

type Layers = Pick<PreviewReadiness, "tcp" | "tls" | "http">;

const MAX_GET_BODY_BYTES = 64 * 1024;

function socketFailure(error: unknown): PreviewErrorCategory {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE")
    return "connection-refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns-failed";
  if (code === "ETIMEDOUT" || code === "PREVIEW_CONNECT_TIMEOUT") return "connect-timeout";
  return "connection-refused";
}

function statusClass(status: number): NonNullable<PreviewReadiness["http"]["statusClass"]> {
  if (status < 200) return "1xx";
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return "4xx";
  return "5xx";
}

/**
 * Bounded, cancellable readiness observation in successive layers: TCP, then
 * verified TLS for HTTPS services, then an HTTP request only to a configured
 * safe path. It never probes URLs copied from terminal output, never follows
 * redirects, and treats 401/403/404 as a reachable application.
 */
export class PreviewReadinessProber implements PreviewReadinessPort {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly queueMax: number;
  private readonly connectTimeoutMs: number;
  private readonly headersTimeoutMs: number;

  constructor(private readonly options: PreviewReadinessOptions = {}) {
    this.concurrency = options.concurrency ?? PREVIEW_LIMITS.probeConcurrency;
    this.queueMax = options.queueMax ?? PREVIEW_LIMITS.probeQueueMax;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
    this.headersTimeoutMs = options.headersTimeoutMs ?? 5_000;
  }

  stats() {
    return { active: this.active, queued: this.queue.length };
  }

  async probe(
    definition: PreviewServiceDefinition,
    target: ResolvedPreviewTarget,
    signal: AbortSignal,
  ): Promise<Layers> {
    await this.acquire(signal);
    try {
      return await this.run(definition, target, signal);
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.queueMax) {
      return Promise.reject(
        Object.assign(new Error("Probe queue full"), { code: "PREVIEW_CAPACITY" }),
      );
    }
    return new Promise((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        this.active += 1;
        resolve();
      };
      const abort = () => {
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error("Probe cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(start);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  private async run(
    definition: PreviewServiceDefinition,
    target: ResolvedPreviewTarget,
    signal: AbortSignal,
  ): Promise<Layers> {
    const layers: Layers = {
      tcp: { state: "pending" },
      tls: { state: definition.scheme === "https" ? "unknown" : "skipped" },
      http: { state: definition.readinessPath ? "unknown" : "skipped" },
    };
    try {
      const socket = await this.connectTcp(target, signal);
      socket.destroy();
      layers.tcp = { state: "ok" };
    } catch (error) {
      layers.tcp = { state: "failed", failure: socketFailure(error) };
      if (layers.tls.state !== "skipped") layers.tls = { state: "skipped" };
      if (layers.http.state !== "skipped") layers.http = { state: "skipped" };
      return layers;
    }
    if (definition.scheme === "https" && target.tls && !target.relay) {
      try {
        await this.verifyTls(target, signal);
        layers.tls = { state: "ok" };
      } catch {
        layers.tls = { state: "failed", failure: "tls-failed" };
        if (layers.http.state !== "skipped") layers.http = { state: "skipped" };
        return layers;
      }
    }
    if (definition.readinessPath && !target.relay) {
      try {
        let status = await this.httpStatus(definition, target, "HEAD", signal);
        // HEAD may be unsupported; the explicit, body-limited GET fallback only
        // ever targets the configured readiness path.
        if (status === 405 || status === 501)
          status = await this.httpStatus(definition, target, "GET", signal);
        layers.http = { state: "ok", statusClass: statusClass(status) };
      } catch (error) {
        layers.http = {
          state: "failed",
          failure:
            (error as { code?: string }).code === "PREVIEW_HEADERS_TIMEOUT"
              ? "headers-timeout"
              : socketFailure(error),
        };
      }
    }
    return layers;
  }

  private connectTcp(target: ResolvedPreviewTarget, signal: AbortSignal): Promise<Socket> {
    if (target.relay && this.options.relayConnect) return this.options.relayConnect(target, signal);
    return new Promise((resolve, reject) => {
      const socket = netConnect({
        host: target.host,
        port: target.port,
        family: target.addressFamily === "ipv6" ? 6 : 4,
      });
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const fail = (error: unknown) => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      const abort = () => fail(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
      const timer = setTimeout(
        () =>
          fail(Object.assign(new Error("connect timeout"), { code: "PREVIEW_CONNECT_TIMEOUT" })),
        this.connectTimeoutMs,
      );
      signal.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        cleanup();
        socket.removeAllListeners("error");
        socket.on("error", () => undefined);
        resolve(socket);
      });
      socket.once("error", fail);
    });
  }

  private verifyTls(target: ResolvedPreviewTarget, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({
        host: target.host,
        port: target.port,
        servername: target.tls?.servername,
        rejectUnauthorized: true,
        ca: this.options.ca?.(),
      });
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error("aborted"));
      const timer = setTimeout(() => finish(new Error("TLS timeout")), this.connectTimeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      socket.once("secureConnect", () => finish());
      socket.once("error", finish);
    });
  }

  private httpStatus(
    definition: PreviewServiceDefinition,
    target: ResolvedPreviewTarget,
    method: "HEAD" | "GET",
    signal: AbortSignal,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const https = definition.scheme === "https";
      const request = (https ? httpsRequest : httpRequest)({
        host: target.host,
        port: target.port,
        family: target.addressFamily === "ipv6" ? 6 : 4,
        method,
        path: definition.readinessPath,
        headers: {
          host: `localhost:${definition.applicationPort}`,
          "user-agent": "orkestrator-preview-readiness",
          accept: "*/*",
        },
        agent: false,
        signal,
        ...(https
          ? {
              servername: target.tls?.servername,
              rejectUnauthorized: true,
              ca: this.options.ca?.(),
            }
          : {}),
      });
      const timer = setTimeout(() => {
        request.destroy(
          Object.assign(new Error("headers timeout"), { code: "PREVIEW_HEADERS_TIMEOUT" }),
        );
      }, this.headersTimeoutMs);
      request.once("response", (response: IncomingMessage) => {
        clearTimeout(timer);
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_GET_BODY_BYTES) response.destroy();
        });
        response.on("error", () => undefined);
        resolve(response.statusCode ?? 0);
        // Do not wait for or keep the body.
        setImmediate(() => response.destroy());
      });
      request.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      request.end();
    });
  }
}
