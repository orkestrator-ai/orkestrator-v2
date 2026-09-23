/**
 * Streaming full-origin forwarding shared by the backend's published-origin
 * proxy and Electron's local ingress. The caller supplies an authorized
 * upstream connection; this module owns request/response streaming, byte and
 * time bounds, cancellation, and safe failure reporting. It never retries.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Transform, type Duplex } from "node:stream";

import {
  downstreamResponseHeaders,
  pairsFromRaw,
  requestHeaderViolation,
  upstreamRequestHeaders,
  type PreviewHeaderPolicy,
} from "./preview-header-policy.js";
import { headerValues, http1Request, PreviewHttp1Error, type HeaderList } from "./preview-http1.js";
import {
  PREVIEW_LIMITS,
  previewError,
  previewErrorFromUnknown,
  previewFailure,
  type PreviewErrorCategory,
} from "./preview-services.js";

export interface PreviewForwardLimits {
  headersTimeoutMs: number;
  bodyIdleTimeoutMs: number;
  uploadMaxBytes: number;
  downloadMaxBytes: number;
  headerMaxBytes: number;
  headerMaxFields: number;
}

export const DEFAULT_PREVIEW_FORWARD_LIMITS: PreviewForwardLimits = {
  headersTimeoutMs: PREVIEW_LIMITS.responseHeadersTimeoutMs,
  bodyIdleTimeoutMs: PREVIEW_LIMITS.bodyIdleTimeoutMs,
  uploadMaxBytes: PREVIEW_LIMITS.uploadMaxBytes,
  downloadMaxBytes: PREVIEW_LIMITS.downloadMaxBytes,
  headerMaxBytes: PREVIEW_LIMITS.headerMaxBytes,
  headerMaxFields: PREVIEW_LIMITS.headerMaxFields,
};

export interface PreviewForwardResult {
  outcome: "completed" | "client-aborted" | "failed" | "rejected";
  category?: PreviewErrorCategory;
  status?: number;
  bytesUp: number;
  bytesDown: number;
}

export interface PreviewForwardHooks {
  /** Open an authorized upstream connection. Throw a PreviewServiceError to fail safely. */
  connect(signal: AbortSignal): Promise<Duplex>;
  /** Register the in-flight exchange for revocation; returns a release. */
  track?(close: () => void): () => void;
  /**
   * Accept an upstream connection back for reuse after a cleanly framed
   * response. When absent, every exchange uses a fresh connection.
   */
  reuse?(socket: Duplex): void;
}

const STATUS: Partial<Record<PreviewErrorCategory, number>> = {
  "invalid-request": 400,
  "access-expired": 401,
  forbidden: 403,
  "not-found": 404,
  "generation-changed": 409,
  "capacity-exceeded": 503,
  "environment-stopped": 503,
  "target-unmapped": 502,
  "target-unverified": 502,
  "connection-refused": 502,
  "dns-failed": 502,
  "tls-failed": 502,
  "connect-timeout": 504,
  "headers-timeout": 504,
  unsupported: 501,
  "backend-unavailable": 502,
  internal: 502,
};

export function previewErrorStatus(category: PreviewErrorCategory): number {
  return STATUS[category] ?? 502;
}

export const PREVIEW_ERROR_HEADER = "x-orkestrator-preview-error";

function categoryOf(error: unknown): PreviewErrorCategory {
  if (error instanceof PreviewHttp1Error) {
    if (error.code === "headers-timeout") return "headers-timeout";
    if (error.code === "invalid-request") return "invalid-request";
    return "internal";
  }
  return previewErrorFromUnknown(error)?.category ?? "internal";
}

/** Write a safe error before any response bytes; never after headers. */
export function writePreviewError(
  response: ServerResponse,
  category: PreviewErrorCategory,
  message?: string,
): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const body = `${message ?? previewError(category).message}\n`;
  response.writeHead(previewErrorStatus(category), {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    [PREVIEW_ERROR_HEADER]: category,
    ...(category === "capacity-exceeded" ? { "retry-after": "2" } : {}),
  });
  response.end(body);
}

function requestBodyLength(headers: HeaderList): { hasBody: boolean; length: number | null } {
  const lengths = headerValues(headers, "content-length");
  const chunked = headerValues(headers, "transfer-encoding").some((value) =>
    /chunked/i.test(value),
  );
  if (chunked) return { hasBody: true, length: null };
  if (lengths.length) {
    const length = Number(lengths[0]);
    return { hasBody: length > 0, length: Number.isSafeInteger(length) ? length : null };
  }
  return { hasBody: false, length: null };
}

function counter(limit: number, onBytes: (bytes: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      onBytes(chunk.length);
      if (total > limit) {
        callback(
          Object.assign(new Error("Upload exceeds the preview limit"), {
            previewCategory: "capacity-exceeded",
          }),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Forward one HTTP request to an authorized upstream and stream the response
 * back unchanged (apart from the header policy). Failures before the response
 * starts return a stable safe error; failures after headers destroy the
 * connection rather than writing an error into an HTML or file stream.
 */
export async function forwardPreviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  policy: PreviewHeaderPolicy,
  limits: PreviewForwardLimits,
  hooks: PreviewForwardHooks,
): Promise<PreviewForwardResult> {
  const method = (request.method ?? "GET").toUpperCase();
  const result: PreviewForwardResult = { outcome: "completed", bytesUp: 0, bytesDown: 0 };
  if (method === "CONNECT" || method === "TRACE") {
    writePreviewError(response, "invalid-request", "Method not supported through the preview.");
    return { ...result, outcome: "rejected", category: "invalid-request", status: 405 };
  }
  const violation = requestHeaderViolation(request.rawHeaders, {
    headerMaxBytes: limits.headerMaxBytes,
    headerMaxFields: limits.headerMaxFields,
  });
  const path = request.url ?? "/";
  if (violation || !path.startsWith("/") || path.startsWith("//")) {
    writePreviewError(response, "invalid-request");
    return { ...result, outcome: "rejected", category: "invalid-request", status: 400 };
  }

  const controller = new AbortController();
  let finished = false;
  let upstream: Duplex | null = null;
  let reused = false;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const abort = () => {
    if (finished) return;
    result.outcome = "client-aborted";
    controller.abort();
    upstream?.destroy();
  };
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableFinished) abort();
  });
  const release = hooks.track?.(() => {
    result.outcome = "failed";
    result.category = "access-expired";
    controller.abort();
    upstream?.destroy();
    if (!response.headersSent) writePreviewError(response, "access-expired");
    else response.destroy();
  });

  try {
    upstream = await hooks.connect(controller.signal);
    if (controller.signal.aborted) throw previewFailure("access-expired");
    if (upstream.listenerCount("error") === 0) upstream.on("error", () => undefined);
    const incoming = pairsFromRaw(request.rawHeaders);
    const { hasBody, length } = requestBodyLength(incoming);
    let uploadFailure: PreviewErrorCategory | null = null;
    const body = hasBody
      ? request
          .pipe(counter(limits.uploadMaxBytes, (bytes) => (result.bytesUp += bytes)))
          .on("error", (error: Error) => {
            uploadFailure =
              (error as { previewCategory?: PreviewErrorCategory }).previewCategory ?? "internal";
            controller.abort();
            upstream?.destroy();
          })
      : null;
    if (length !== null && length > limits.uploadMaxBytes) {
      throw Object.assign(new Error("Upload exceeds the preview limit"), {
        previewCategory: "capacity-exceeded",
      });
    }
    const upstreamResponse = await http1Request(upstream, {
      method,
      path,
      headers: upstreamRequestHeaders(incoming, policy),
      body,
      bodyLength: length,
      headersTimeoutMs: limits.headersTimeoutMs,
      maxHeaderBytes: limits.headerMaxBytes,
      maxHeaderFields: limits.headerMaxFields,
      signal: controller.signal,
      keepAlive: Boolean(hooks.reuse),
      onReusable: (socket) => {
        reused = true;
        hooks.reuse?.(socket);
      },
    }).catch((error: unknown) => {
      if (uploadFailure)
        throw Object.assign(new Error("upload failed"), { previewCategory: uploadFailure });
      throw error;
    });
    const { headers } = downstreamResponseHeaders(upstreamResponse.headers, policy);
    const contentType = String(headers["content-type"] ?? "");
    const streaming = /^text\/event-stream/i.test(contentType);
    result.status = upstreamResponse.statusCode;
    response.writeHead(
      upstreamResponse.statusCode,
      upstreamResponse.statusMessage || undefined,
      headers,
    );
    response.flushHeaders?.();

    await new Promise<void>((resolve) => {
      const bodyStream = upstreamResponse.body;
      const resetIdle = () => {
        if (streaming) return; // Long-lived event streams are bounded by the access lease instead.
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          result.outcome = "failed";
          result.category = "headers-timeout";
          bodyStream.destroy();
          response.destroy();
          resolve();
        }, limits.bodyIdleTimeoutMs);
      };
      resetIdle();
      bodyStream.on("data", (chunk: Buffer) => {
        result.bytesDown += chunk.length;
        if (!streaming && result.bytesDown > limits.downloadMaxBytes) {
          result.outcome = "failed";
          result.category = "capacity-exceeded";
          bodyStream.destroy();
          response.destroy();
          resolve();
          return;
        }
        resetIdle();
        if (!response.write(chunk)) {
          bodyStream.pause();
          response.once("drain", () => bodyStream.resume());
        }
      });
      bodyStream.once("end", () => {
        response.end();
        resolve();
      });
      bodyStream.once("error", () => {
        if (result.outcome === "completed") {
          result.outcome = controller.signal.aborted ? "client-aborted" : "failed";
          result.category ??= "internal";
        }
        response.destroy();
        resolve();
      });
      response.once("close", () => {
        bodyStream.destroy();
        resolve();
      });
    });
    return result;
  } catch (error) {
    const category =
      (error as { previewCategory?: PreviewErrorCategory }).previewCategory ?? categoryOf(error);
    if (result.outcome !== "client-aborted") {
      result.outcome = "failed";
      result.category = category;
      result.status = previewErrorStatus(category);
      writePreviewError(
        response,
        category,
        category === "capacity-exceeded" ? "The request exceeds the preview limits." : undefined,
      );
    }
    return result;
  } finally {
    finished = true;
    if (idle) clearTimeout(idle);
    request.off("aborted", abort);
    if (!reused) upstream?.destroy();
    release?.();
  }
}

/** Write a raw HTTP error on a socket that has not been upgraded. */
export function rejectPreviewUpgrade(
  socket: Duplex,
  category: PreviewErrorCategory,
  message?: string,
): void {
  if (socket.destroyed) return;
  const status = previewErrorStatus(category);
  const body = `${message ?? previewError(category).message}\n`;
  socket.end(
    `HTTP/1.1 ${status} Preview Error\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${PREVIEW_ERROR_HEADER}: ${category}\r\nconnection: close\r\n\r\n${body}`,
  );
  setTimeout(() => socket.destroy(), 1_000).unref?.();
}

export interface PreviewUpgradeResult {
  outcome: "open" | "rejected" | "failed";
  category?: PreviewErrorCategory;
  /** Resolves when the upgraded connection has closed on both legs. */
  closed: Promise<void>;
}

/**
 * Forward a WebSocket upgrade as a transparent byte tunnel after validating
 * the handshake. The application's subprotocols, extensions, binary frames,
 * and close semantics pass end to end; nothing is replayed after a disconnect.
 */
export async function forwardPreviewUpgrade(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  policy: PreviewHeaderPolicy,
  limits: PreviewForwardLimits,
  hooks: PreviewForwardHooks,
): Promise<PreviewUpgradeResult> {
  const done = Promise.resolve();
  const incoming = pairsFromRaw(request.rawHeaders);
  const upgrade = headerValues(incoming, "upgrade")[0]?.toLowerCase();
  const path = request.url ?? "/";
  if (
    request.method !== "GET" ||
    upgrade !== "websocket" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    requestHeaderViolation(request.rawHeaders, limits)
  ) {
    rejectPreviewUpgrade(client, "invalid-request");
    return { outcome: "rejected", category: "invalid-request", closed: done };
  }
  const offered = headerValues(incoming, "sec-websocket-protocol")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const controller = new AbortController();
  const clientClosed = () => controller.abort();
  client.once("close", clientClosed);
  client.on("error", () => undefined);
  let upstream: Duplex | null = null;
  let release: (() => void) | undefined;
  try {
    upstream = await hooks.connect(controller.signal);
    upstream.on("error", () => undefined);
    const answer = await http1Request(upstream, {
      method: "GET",
      path,
      headers: upstreamRequestHeaders(incoming, policy, { upgrade: true }),
      headersTimeoutMs: limits.headersTimeoutMs,
      maxHeaderBytes: limits.headerMaxBytes,
      maxHeaderFields: limits.headerMaxFields,
      signal: controller.signal,
      upgrade: true,
    });
    client.off("close", clientClosed);
    if (answer.statusCode !== 101) {
      const { headers } = downstreamResponseHeaders(answer.headers, policy);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of answer.body) {
        size += (chunk as Buffer).length;
        if (size > 64 * 1024) break;
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      const lines = [`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}`];
      for (const [name, value] of Object.entries(headers)) {
        if (name === "content-length") continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      lines.push(`content-length: ${body.length}`, "connection: close");
      client.end(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), body]));
      upstream.destroy();
      return { outcome: "rejected", closed: done };
    }
    const selected = headerValues(answer.headers, "sec-websocket-protocol")[0];
    if (selected !== undefined && !offered.includes(selected)) {
      upstream.destroy();
      rejectPreviewUpgrade(
        client,
        "internal",
        "The application selected a subprotocol the page did not offer.",
      );
      return { outcome: "failed", category: "internal", closed: done };
    }
    const { headers } = downstreamResponseHeaders(answer.headers, policy, { upgrade: true });
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
    }
    if (client.destroyed) {
      upstream.destroy();
      return { outcome: "failed", category: "internal", closed: done };
    }
    client.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (answer.upgradeHead?.length) client.write(answer.upgradeHead);
    if (head.length) upstream.write(head);
    const up = upstream;
    const closed = new Promise<void>((resolve) => {
      let open = 2;
      const closeBoth = () => {
        client.destroy();
        up.destroy();
      };
      const onClose = () => {
        closeBoth();
        open -= 1;
        if (open <= 0) {
          release?.();
          resolve();
        }
      };
      client.once("close", onClose);
      up.once("close", onClose);
      release = hooks.track?.(closeBoth);
    });
    client.pipe(up);
    up.pipe(client);
    up.resume();
    return { outcome: "open", closed };
  } catch (error) {
    client.off("close", clientClosed);
    upstream?.destroy();
    release?.();
    const category = categoryOf(error);
    rejectPreviewUpgrade(client, category);
    return { outcome: "failed", category, closed: done };
  }
}
