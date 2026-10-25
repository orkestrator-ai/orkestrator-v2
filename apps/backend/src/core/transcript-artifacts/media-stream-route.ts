/**
 * Range-capable media capabilities served by the artifact content listener
 * (`/m/<capability>`; see content-server.ts for the origin and credential
 * boundary).
 *
 * A capability is a random 256-bit table key bound to one file that an
 * authenticated backend command resolved through a confined reader. It
 * carries no application authority: the listener has no application routes
 * and never reads cookies. Every request re-runs the capability's
 * `authorize()` (the environment and stream still exist) and `resolve()`
 * (re-opens the file through the same confinement), then checks the opened
 * file is the one minted (size and identity) and re-sniffs its leading bytes;
 * any mismatch or failure revokes the capability and answers 404.
 *
 * Responses: `GET`/`HEAD`, one byte range per request (`206` with
 * `Content-Range`; `416` with `Content-Range: bytes *\/<size>` for a
 * malformed, multiple or unsatisfiable range), `Accept-Ranges: bytes`, the
 * sniffed type, `nosniff`, `private, no-store`, a `sandbox` CSP and
 * `no-referrer`. Never a redirect. Range bodies are capped at
 * `MEDIA_RANGE_RESPONSE_MAX_BYTES` (an open-ended range is answered with the
 * capped span, which media elements continue from); a request without
 * `Range` streams the whole (size-capped) file with backpressure. Concurrent
 * responses are bounded globally and per capability; a slow reader that
 * stops draining is disconnected. Capabilities are bearer secrets: nothing
 * here logs a URL or token.
 */
import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MEDIA_SNIFF_BYTES,
  isServedMediaMime,
  sniffServedMediaMime,
} from "./media-stream-sniff.js";

export const MEDIA_CAPABILITY_PATTERN = /^\/m\/([A-Za-z0-9_-]{43})$/;
/** Idle lifetime: every served request extends it, up to the absolute lifetime. */
export const MEDIA_CAPABILITY_IDLE_TTL_MS = 15 * 60 * 1000;
export const MEDIA_CAPABILITY_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
export const MEDIA_CAPABILITY_MAX_ENTRIES = 256;
/** Largest body of one ranged response. */
export const MEDIA_RANGE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_MAX_CONCURRENT_RESPONSES = 16;
export const MEDIA_MAX_RESPONSES_PER_CAPABILITY = 4;
const MEDIA_CHUNK_BYTES = 64 * 1024;
const MEDIA_DRAIN_TIMEOUT_MS = 30_000;
const MEDIA_AUTHORIZE_TIMEOUT_MS = 5_000;
const MEDIA_RESOLVE_TIMEOUT_MS = 10_000;

/**
 * Media responses never execute: a top-level navigation to one renders in an
 * opaque-origin sandbox and nothing may frame it. Embedding by `<video>` /
 * `<audio>` / `<img>` is a no-cors subresource load, unaffected by the CSP.
 */
export const MEDIA_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; sandbox";

/**
 * The application page and the content origin are deliberately different
 * sites (127.0.0.1 vs localhost, or a hosted content site), so `same-site`
 * would block the application's `<video>` (verified in Chromium by
 * content-server.browser.test.ts). The URL is an unguessable, short-lived
 * bearer capability and `nosniff` plus the sniffed media type stop it being
 * consumed as script or style.
 */
export const MEDIA_CROSS_ORIGIN_RESOURCE_POLICY = "cross-origin";

export interface OpenedMediaFile {
  /** Owned by the route: closed after the response. */
  handle: FileHandle;
  size: number;
  /** Stable identity of the opened file (device, inode, size, mtime). */
  identity: string;
}

export interface MintMediaInput {
  /** Revocation group (the environment id). */
  ownerKey: string;
  /** Sniffed from the bytes when minting; re-checked on every request. */
  mimeType: string;
  byteLength: number;
  identity: string;
  /** Re-opens the file through the authorized, confined reader. */
  resolve: () => Promise<OpenedMediaFile>;
  /** Re-checked before every response; `false`, a rejection or a timeout revokes. */
  authorize: () => Promise<boolean>;
  idleTtlMs?: number;
}

interface MediaCapability {
  ownerKey: string;
  mimeType: string;
  byteLength: number;
  identity: string;
  resolve: () => Promise<OpenedMediaFile>;
  authorize: () => Promise<boolean>;
  idleTtlMs: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  generation: string;
  active: number;
}

export type ParsedMediaRange =
  | { kind: "none" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

/**
 * One `bytes=` range against a representation of `size` bytes. Suffix
 * (`-N`), open-ended (`N-`) and closed (`N-M`) forms are supported; the
 * served span is capped at `maxBytes`. Several ranges, other units, malformed
 * values and ranges starting past the end are unsatisfiable.
 */
export function parseMediaRange(
  header: string | undefined,
  size: number,
  maxBytes = MEDIA_RANGE_RESPONSE_MAX_BYTES,
): ParsedMediaRange {
  if (header === undefined) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "unsatisfiable" };
  const [, first = "", last = ""] = match;
  if ((first === "" && last === "") || first.length > 16 || last.length > 16) {
    return { kind: "unsatisfiable" };
  }
  let start: number;
  let end: number;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === "" ? size - 1 : Number(last);
    if (start >= size || end < start) return { kind: "unsatisfiable" };
    end = Math.min(end, size - 1);
  }
  return { kind: "range", start, end: Math.min(end, start + Math.max(1, maxBytes) - 1) };
}

type ErrorWriter = (status: number, message: string, extra?: Record<string, string>) => void;

function token(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolves once the response drains; rejects if it closes or stalls first. */
function drained(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("drain timeout")), MEDIA_DRAIN_TIMEOUT_MS);
    const onDrain = () => finish();
    const onClose = () => finish(new Error("closed"));
    function finish(error?: Error) {
      clearTimeout(timer);
      response.off("drain", onDrain);
      response.off("close", onClose);
      if (error) reject(error);
      else resolve();
    }
    response.on("drain", onDrain);
    response.on("close", onClose);
  });
}

async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

export class MediaCapabilityTable {
  private readonly entries = new Map<string, MediaCapability>();
  private readonly byGeneration = new Map<string, string>();
  private activeResponses = 0;

  constructor(
    private readonly now: () => number,
    private readonly maxEntries = MEDIA_CAPABILITY_MAX_ENTRIES,
    private readonly rangeMaxBytes = MEDIA_RANGE_RESPONSE_MAX_BYTES,
  ) {}

  mint(
    baseOrigin: string,
    input: MintMediaInput,
  ): { url: string; expiresAt: string; generation: string } {
    if (!isServedMediaMime(input.mimeType))
      throw new Error("Only audio, video and image media are served");
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
      throw new Error("Invalid media length");
    }
    this.prune();
    const idleTtlMs = Math.min(
      MEDIA_CAPABILITY_MAX_LIFETIME_MS,
      Math.max(1_000, input.idleTtlMs ?? MEDIA_CAPABILITY_IDLE_TTL_MS),
    );
    const now = this.now();
    const capability = token(32);
    const generation = token(18);
    const entry: MediaCapability = {
      ownerKey: input.ownerKey,
      mimeType: input.mimeType,
      byteLength: input.byteLength,
      identity: input.identity,
      resolve: input.resolve,
      authorize: input.authorize,
      idleTtlMs,
      expiresAt: now + idleTtlMs,
      absoluteExpiresAt: now + MEDIA_CAPABILITY_MAX_LIFETIME_MS,
      generation,
      active: 0,
    };
    this.entries.set(capability, entry);
    this.byGeneration.set(generation, capability);
    return {
      url: `${baseOrigin}/m/${capability}`,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      generation,
    };
  }

  /** Whether the capability is still live (pruning it when expired). */
  isLive(generation: string): boolean {
    const capability = this.byGeneration.get(generation);
    const entry = capability ? this.entries.get(capability) : undefined;
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.revoke(generation);
      return false;
    }
    return true;
  }

  revoke(generation: string): void {
    const capability = this.byGeneration.get(generation);
    if (capability) this.entries.delete(capability);
    this.byGeneration.delete(generation);
  }

  revokeOwner(ownerKey: string): void {
    for (const [capability, entry] of Array.from(this.entries)) {
      if (entry.ownerKey !== ownerKey) continue;
      this.entries.delete(capability);
      this.byGeneration.delete(entry.generation);
    }
  }

  clear(): void {
    this.entries.clear();
    this.byGeneration.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [capability, entry] of Array.from(this.entries)) {
      if (entry.expiresAt <= now) {
        this.entries.delete(capability);
        this.byGeneration.delete(entry.generation);
      }
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (entry) this.byGeneration.delete(entry.generation);
    }
  }

  private async authorized(entry: MediaCapability): Promise<boolean> {
    try {
      return (await withTimeout(entry.authorize, MEDIA_AUTHORIZE_TIMEOUT_MS)) === true;
    } catch {
      return false;
    }
  }

  /**
   * Serves one request for `capability`. `baseHeaders` are the listener's
   * headers for every response; `error` writes a listener error response.
   */
  async serve(
    request: IncomingMessage,
    response: ServerResponse,
    capability: string,
    baseHeaders: Readonly<Record<string, string>>,
    error: ErrorWriter,
  ): Promise<void> {
    const entry = this.entries.get(capability);
    if (!entry) {
      error(404, "Not found");
      return;
    }
    if (entry.expiresAt <= this.now()) {
      this.revoke(entry.generation);
      error(410, "Expired");
      return;
    }
    if (
      this.activeResponses >= MEDIA_MAX_CONCURRENT_RESPONSES ||
      entry.active >= MEDIA_MAX_RESPONSES_PER_CAPABILITY
    ) {
      error(503, "Busy", { "retry-after": "1" });
      return;
    }
    this.activeResponses++;
    entry.active++;
    let opened: OpenedMediaFile | undefined;
    try {
      if (!(await this.authorized(entry))) {
        if (this.entries.get(capability) === entry) this.revoke(entry.generation);
        error(404, "Not found");
        return;
      }
      try {
        opened = await withTimeout(entry.resolve, MEDIA_RESOLVE_TIMEOUT_MS);
      } catch {
        // Moved, deleted, or no longer confined: an honest "gone".
        this.revoke(entry.generation);
        error(404, "Not found");
        return;
      }
      if (this.entries.get(capability) !== entry) {
        error(404, "Not found");
        return;
      }
      const head = await readAt(opened.handle, Math.min(opened.size, MEDIA_SNIFF_BYTES), 0);
      if (
        opened.size !== entry.byteLength ||
        opened.identity !== entry.identity ||
        sniffServedMediaMime(head) !== entry.mimeType
      ) {
        // The file changed since minting: never serve different bytes under it.
        this.revoke(entry.generation);
        error(404, "Not found");
        return;
      }
      const size = opened.size;
      const range = parseMediaRange(
        typeof request.headers.range === "string" ? request.headers.range : undefined,
        size,
        this.rangeMaxBytes,
      );
      if (range.kind === "unsatisfiable") {
        error(416, "Range not satisfiable", {
          "content-range": `bytes */${size}`,
          "accept-ranges": "bytes",
        });
        return;
      }
      entry.expiresAt = Math.min(entry.absoluteExpiresAt, this.now() + entry.idleTtlMs);
      const start = range.kind === "range" ? range.start : 0;
      const end = range.kind === "range" ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;
      response.writeHead(range.kind === "range" ? 206 : 200, {
        ...baseHeaders,
        "cross-origin-resource-policy": MEDIA_CROSS_ORIGIN_RESOURCE_POLICY,
        "content-security-policy": MEDIA_CONTENT_SECURITY_POLICY,
        "content-type": entry.mimeType,
        "accept-ranges": "bytes",
        "content-length": String(length),
        ...(range.kind === "range" ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      });
      if (request.method === "HEAD" || length === 0) {
        response.end();
        return;
      }
      await this.pipe(opened.handle, response, start, end);
    } finally {
      this.activeResponses--;
      entry.active--;
      await opened?.handle.close().catch(() => undefined);
    }
  }

  private async pipe(
    handle: FileHandle,
    response: ServerResponse,
    start: number,
    end: number,
  ): Promise<void> {
    let position = start;
    try {
      while (position <= end) {
        if (response.destroyed) return;
        const chunk = await readAt(
          handle,
          Math.min(MEDIA_CHUNK_BYTES, end - position + 1),
          position,
        );
        // Truncated underneath us: the declared length can no longer be met.
        if (chunk.byteLength === 0) break;
        position += chunk.byteLength;
        if (!response.write(chunk)) await drained(response);
      }
    } catch {
      response.destroy();
      return;
    }
    if (position <= end) response.destroy();
    else response.end();
  }
}
