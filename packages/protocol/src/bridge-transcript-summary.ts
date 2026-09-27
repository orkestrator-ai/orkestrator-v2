/**
 * Lightweight bridge transcripts, exact detail reads and direct history pages.
 *
 * The v1 bridge envelope windows raw messages, so a single tool result or
 * pasted screenshot counts against the 512 KiB live window at full size and
 * can push every earlier message out of it — only for the backend to replace
 * that very payload with a detail reference moments later. Version 2 moves the
 * substitution to the bridge, before windowing:
 *
 * - **Summaries.** A part's large bodies (tool output and error, diff text,
 *   inline image bytes) are replaced by a {@link BridgePartDetail}: an opaque
 *   locator, the body's encoded size, and which fields it holds. Everything a
 *   row needs to render collapsed stays inline.
 * - **Details.** `GET /session/:id/transcript/detail?locator=` returns exactly
 *   the value the summary described, or an explicit `missing`, `expired` or
 *   `too-large` outcome. The locator carries a digest of the body it was
 *   minted for, so a later mutation of the same part can never be served as
 *   the revision a reader asked for.
 * - **Pages.** `GET /session/:id/transcript/page?cursor=` serves the summaries
 *   before a position within one content epoch, so history does not require
 *   the backend to rebuild and fingerprint a joined projection first.
 *
 * Every function here works on the normalized message shape every bridge
 * already serves (`id`, `role`, `content`, `parts`, `createdAt`), so each
 * bridge adopts the contract by calling these helpers from its routes. The
 * v1 envelope in `progressive-transcript.ts` is unchanged: capability is
 * discovered from the envelope's own `version` discriminator, which an older
 * bridge that ignores `version=2` answers as `1`.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  BRIDGE_TRANSCRIPT_MAX_MESSAGES,
  BRIDGE_TRANSCRIPT_TARGET_BYTES,
  bridgeTranscriptToken,
  type BridgeTranscriptReadOptions,
} from "./progressive-transcript.js";
import { boundTranscriptResponse } from "./transcript-window.js";

export const BRIDGE_TRANSCRIPT_SUMMARY_VERSION = 2 as const;
export const BRIDGE_TRANSCRIPT_DETAIL_VERSION = 1 as const;
export const BRIDGE_TRANSCRIPT_PAGE_VERSION = 1 as const;

/** The same ceilings the backend applies to its own deferred details. */
export const BRIDGE_TOOL_DETAIL_MAX_BYTES = 4 * 1024 * 1024;
export const BRIDGE_FILE_DETAIL_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Bodies at or below this size stay inline. A round trip costs more than a
 * few kilobytes, and the backend defers what it receives inline anyway.
 */
export const BRIDGE_SUMMARY_INLINE_DETAIL_BYTES = 4 * 1024;
export const BRIDGE_DETAIL_LOCATOR_MAX_LENGTH = 2 * 1024;
export const BRIDGE_PAGE_CURSOR_MAX_LENGTH = 1024;
export const BRIDGE_PAGE_MAX_MESSAGES = 200;
export const BRIDGE_PAGE_TARGET_BYTES = 1024 * 1024;
/** Nesting the summarizer follows; deeper structures are passed through as-is. */
const MAX_SUMMARY_DEPTH = 8;
const NESTED_PART_FIELDS = ["parts", "childTools", "subagentActions"] as const;

export type BridgeDetailField = "toolOutput" | "toolError" | "toolDiff" | "fileDataUrl";

/** Where a summarized part's large bodies went. */
export interface BridgePartDetail {
  locator: string;
  /** Encoded JSON bytes of the detail payload. */
  bytes: number;
  fields: BridgeDetailField[];
}

export interface BridgeDetailPayload {
  toolOutput?: string;
  toolError?: string;
  toolDiff?: Record<string, unknown>;
  fileDataUrl?: string;
}

export type BridgeTranscriptDetailResponse =
  | { version: 1; status: "ok"; detail: BridgeDetailPayload; bytes: number }
  | { version: 1; status: "missing" | "expired" | "too-large" | "invalid" };

export type BridgeTranscriptPageResponse =
  | {
      version: 1;
      status: "page";
      messages: unknown[];
      /** Absolute position of `messages[0]` within the cursor's content epoch. */
      startIndex: number;
      /** Cursor for the page before this one; absent when this page starts history. */
      nextCursor?: string;
      /** True when nothing before `startIndex` was ever lost. */
      complete: boolean;
      /** True when a row in this page was cut to fit its byte target. */
      truncated: boolean;
      generation: string | number;
      contentEpoch: string | number;
    }
  | { version: 1; status: "expired" | "invalid" };

export interface BridgeTranscriptCapabilities {
  details: boolean;
  pages: boolean;
}

// ---------------------------------------------------------------------------
// Locators

interface LocatorBody {
  /** Message id. */
  m: string;
  /** Path to the part: the top-level key, then nested field/index segments. */
  p: string[];
  /** Digest of the exact detail payload the summary described. */
  d: string;
}

const LOCATOR_PREFIX = "bd1.";

function encodeLocator(body: LocatorBody): string | undefined {
  const locator = LOCATOR_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url");
  return locator.length <= BRIDGE_DETAIL_LOCATOR_MAX_LENGTH ? locator : undefined;
}

function decodeLocator(locator: string): LocatorBody | undefined {
  if (
    typeof locator !== "string" ||
    !locator.startsWith(LOCATOR_PREFIX) ||
    locator.length > BRIDGE_DETAIL_LOCATOR_MAX_LENGTH
  ) {
    return undefined;
  }
  try {
    const body = JSON.parse(
      Buffer.from(locator.slice(LOCATOR_PREFIX.length), "base64url").toString("utf8"),
    ) as unknown;
    if (!isRecord(body)) return undefined;
    const { m, p, d } = body;
    if (typeof m !== "string" || typeof d !== "string" || !Array.isArray(p)) return undefined;
    if (p.length === 0 || p.length > MAX_SUMMARY_DEPTH * 2 + 1) return undefined;
    if (!p.every((segment) => typeof segment === "string")) return undefined;
    return { m, p: p as string[], d };
  } catch {
    return undefined;
  }
}

/** Whether a string is shaped like a locator this module mints. */
export function isBridgeDetailLocator(value: unknown): value is string {
  return typeof value === "string" && decodeLocator(value) !== undefined;
}

const DETAIL_FIELDS: ReadonlySet<string> = new Set([
  "toolOutput",
  "toolError",
  "toolDiff",
  "fileDataUrl",
]);

/** A summary part's `detail`, validated, or undefined when absent or malformed. */
export function readBridgePartDetail(value: unknown): BridgePartDetail | undefined {
  if (!isRecord(value) || !isBridgeDetailLocator(value.locator)) return undefined;
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) return undefined;
  if (!Array.isArray(value.fields) || value.fields.length === 0 || value.fields.length > 4) {
    return undefined;
  }
  if (!value.fields.every((field) => typeof field === "string" && DETAIL_FIELDS.has(field))) {
    return undefined;
  }
  return {
    locator: value.locator,
    bytes: value.bytes as number,
    fields: value.fields as BridgeDetailField[],
  };
}

// ---------------------------------------------------------------------------
// Detail extraction

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function heavyDiff(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const diff = part.toolDiff;
  if (!isRecord(diff)) return undefined;
  return typeof diff.diff === "string" ||
    typeof diff.before === "string" ||
    typeof diff.after === "string"
    ? diff
    : undefined;
}

function readablePathContent(content: unknown): boolean {
  return (
    typeof content === "string" &&
    (content.startsWith("/") || content.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(content))
  );
}

/**
 * The detail payload of one part, or undefined when it has nothing heavy.
 *
 * Mirrors what the backend's projection defers: tool output and error, diff
 * bodies, and an inline image that has no readable path to re-read it from.
 * A data URL beside a readable path is pure duplication; the summary drops it
 * without a detail, exactly as the projection does.
 */
function detailPayload(part: Record<string, unknown>): BridgeDetailPayload | undefined {
  const payload: BridgeDetailPayload = {};
  if (typeof part.toolOutput === "string") payload.toolOutput = part.toolOutput;
  if (typeof part.toolError === "string") payload.toolError = part.toolError;
  const diff = heavyDiff(part);
  if (diff) payload.toolDiff = diff;
  if (
    (part.type === "image" || part.type === "file") &&
    typeof part.fileUrl === "string" &&
    part.fileUrl.startsWith("data:image/") &&
    !readablePathContent(part.content)
  ) {
    payload.fileDataUrl = part.fileUrl;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

/** Every value a detail payload reads, compared by reference to detect change. */
function detailInputs(part: Record<string, unknown>): unknown[] {
  const diff = isRecord(part.toolDiff) ? part.toolDiff : undefined;
  return [
    part.type,
    part.content,
    part.toolOutput,
    part.toolError,
    part.fileUrl,
    part.toolDiff,
    // A diff object can be patched in place; its fields are part of the value.
    ...(diff ? Object.keys(diff).flatMap((key) => [key, diff[key]]) : []),
  ];
}

interface MeasuredDetail {
  inputs: unknown[];
  bytes: number;
  digest: string;
}

/**
 * Per-part memo of the last measured payload.
 *
 * Keyed by the part object and validated by reference equality of every value
 * the payload reads, so a part mutated in place (tool cards are patched every
 * frame) is re-measured, while an unchanged card costs a few comparisons
 * instead of re-hashing a half-megabyte body on every summary read. Strings
 * are compared by value, which is a pointer check when the reference is kept.
 */
const measuredDetails = new WeakMap<object, MeasuredDetail>();

function measureDetail(
  part: Record<string, unknown>,
  payload: BridgeDetailPayload,
): { bytes: number; digest: string } {
  const inputs = detailInputs(part);
  const cached = measuredDetails.get(part);
  if (
    cached &&
    cached.inputs.length === inputs.length &&
    cached.inputs.every((value, index) => value === inputs[index])
  ) {
    return cached;
  }
  const measured = digestPayload(payload);
  measuredDetails.set(part, { inputs, ...measured });
  return measured;
}

function digestPayload(payload: BridgeDetailPayload): { bytes: number; digest: string } {
  const serialized = JSON.stringify(payload);
  return {
    bytes: Buffer.byteLength(serialized),
    digest: createHash("sha256").update(serialized).digest("base64url").slice(0, 32),
  };
}

// ---------------------------------------------------------------------------
// Summaries

function topLevelKey(part: unknown, index: number): string {
  if (isRecord(part)) {
    if (typeof part.sourcePartId === "string" && part.sourcePartId.length <= 512) {
      return `s:${part.sourcePartId}`;
    }
    if (typeof part.toolUseId === "string" && part.toolUseId.length <= 512) {
      return `t:${part.toolUseId}`;
    }
  }
  return `i:${index}`;
}

function summarizePart(raw: unknown, messageId: string, path: string[], depth: number): unknown {
  if (!isRecord(raw) || depth > MAX_SUMMARY_DEPTH) return raw;
  const part = raw;
  let summary: Record<string, unknown> | undefined;
  const writable = () => (summary ??= { ...part });

  const payload = detailPayload(part);
  if (payload) {
    const measured = measureDetail(part, payload);
    const locator =
      measured.bytes > BRIDGE_SUMMARY_INLINE_DETAIL_BYTES
        ? encodeLocator({ m: messageId, p: path, d: measured.digest })
        : undefined;
    if (locator) {
      const next = writable();
      delete next.toolOutput;
      delete next.toolError;
      const diff = heavyDiff(part);
      if (diff) {
        next.toolDiff = {
          ...(typeof diff.filePath === "string" ? { filePath: diff.filePath } : {}),
          ...(typeof diff.additions === "number" ? { additions: diff.additions } : {}),
          ...(typeof diff.deletions === "number" ? { deletions: diff.deletions } : {}),
          deferred: true,
        };
      }
      if (payload.fileDataUrl) delete next.fileUrl;
      next.detail = {
        locator,
        bytes: measured.bytes,
        fields: Object.keys(payload) as BridgeDetailField[],
      } satisfies BridgePartDetail;
    }
  }
  // A data URL beside a readable path is duplication with or without a detail.
  if (
    (part.type === "image" || part.type === "file") &&
    typeof part.fileUrl === "string" &&
    part.fileUrl.startsWith("data:") &&
    readablePathContent(part.content)
  ) {
    delete writable().fileUrl;
  }
  if (typeof part.content === "string" && part.content.startsWith("data:")) {
    const filename = typeof part.filename === "string" ? part.filename.trim() : "";
    writable().content = filename || (part.type === "image" ? "image" : "Attached file");
  }

  for (const field of NESTED_PART_FIELDS) {
    const children = part[field];
    if (!Array.isArray(children)) continue;
    let changed = false;
    const next = children.map((child, index) => {
      const summarized = summarizePart(
        child,
        messageId,
        [...path, field, String(index)],
        depth + 1,
      );
      if (summarized !== child) changed = true;
      return summarized;
    });
    if (changed) writable()[field] = next;
  }
  if (isRecord(part.task)) {
    const task = summarizePart(part.task, messageId, [...path, "task"], depth + 1);
    if (task !== part.task) writable().task = task;
  }
  return summary ?? part;
}

interface SummarizableMessage {
  id: string;
  parts: unknown[];
}

function isSummarizable(
  message: unknown,
): message is SummarizableMessage & Record<string, unknown> {
  return isRecord(message) && typeof message.id === "string" && Array.isArray(message.parts);
}

/**
 * The lightweight form of one normalized message. Returns the message itself
 * when nothing needed replacing, so an unchanged light message costs no copy.
 */
export function summarizeBridgeMessage<T>(message: T): T {
  if (!isSummarizable(message)) return message;
  let changed = false;
  const parts = message.parts.map((part, index) => {
    const summarized = summarizePart(part, message.id, [topLevelKey(part, index)], 0);
    if (summarized !== part) changed = true;
    return summarized;
  });
  return changed ? ({ ...message, parts } as T) : message;
}

// ---------------------------------------------------------------------------
// Detail reads

function resolvePath(message: SummarizableMessage, path: string[]): unknown {
  const [top, ...rest] = path;
  if (!top) return undefined;
  let current: unknown;
  if (top.startsWith("s:")) {
    const id = top.slice(2);
    current = message.parts.find((part) => isRecord(part) && part.sourcePartId === id);
  } else if (top.startsWith("t:")) {
    const id = top.slice(2);
    current = message.parts.find(
      (part) => isRecord(part) && part.toolUseId === id && typeof part.sourcePartId !== "string",
    );
  } else if (top.startsWith("i:")) {
    current = message.parts[Number(top.slice(2))];
  }
  for (let index = 0; index < rest.length; index += 1) {
    if (!isRecord(current)) return undefined;
    const field = rest[index]!;
    if (field === "task") {
      current = current.task;
      continue;
    }
    if (!(NESTED_PART_FIELDS as readonly string[]).includes(field)) return undefined;
    const children = current[field];
    const position = Number(rest[index + 1]);
    index += 1;
    if (!Array.isArray(children) || !Number.isSafeInteger(position)) return undefined;
    current = children[position];
  }
  return current;
}

/**
 * Serve the exact detail a summary's locator named.
 *
 * `missing`: the message or part is no longer retained (trimmed, rewound, or
 * never existed). `expired`: the part is still there but its body changed, so
 * the revision the reader asked for no longer exists anywhere. Neither is
 * reported as an empty result.
 */
export function readBridgeTranscriptDetail(
  messages: readonly unknown[],
  locator: string,
): BridgeTranscriptDetailResponse {
  const body = decodeLocator(locator);
  if (!body) return { version: 1, status: "invalid" };
  let message: SummarizableMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (isSummarizable(candidate) && candidate.id === body.m) {
      message = candidate;
      break;
    }
  }
  if (!message) return { version: 1, status: "missing" };
  const part = resolvePath(message, body.p);
  if (!isRecord(part)) return { version: 1, status: "missing" };
  const payload = detailPayload(part);
  if (!payload) return { version: 1, status: "expired" };
  const measured = digestPayload(payload);
  if (measured.digest !== body.d) return { version: 1, status: "expired" };
  const limit = payload.fileDataUrl ? BRIDGE_FILE_DETAIL_MAX_BYTES : BRIDGE_TOOL_DETAIL_MAX_BYTES;
  if (measured.bytes > limit) return { version: 1, status: "too-large" };
  return { version: 1, status: "ok", detail: payload, bytes: measured.bytes };
}

// ---------------------------------------------------------------------------
// Summary envelope

export type BridgeTranscriptSummaryUpdate =
  | { version: 2; status: "unchanged"; token: string }
  | {
      version: 2;
      status: "snapshot";
      token: string;
      value: {
        messages: unknown[];
        /** Absolute position of the first returned message within contentEpoch. */
        startIndex: number;
        complete: boolean;
        messageWindow: {
          truncated: boolean;
          truncationReason?: "count" | "bytes";
          omittedMessages?: number;
          omittedParts?: number;
        };
        revision?: number;
        generation: string | number;
        contentEpoch: string | number;
        freshness: "cached" | "current";
        title?: string;
        /** Cursor for the page before `startIndex`, when there is one. */
        historyCursor?: string;
        capabilities: BridgeTranscriptCapabilities;
      };
    };

export interface BridgeTranscriptSummaryOptions extends BridgeTranscriptReadOptions {
  /** Whether this bridge serves `/transcript/page`. */
  pages?: boolean;
}

function boundedInteger(value: number, maximum: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

/**
 * The v2 conditional envelope: summaries are built for the candidate window
 * only, and windowing measures summaries rather than raw bodies. With a
 * revision, an unchanged read touches no message at all.
 */
export function bridgeTranscriptSummaryUpdate(
  messages: readonly unknown[],
  options: BridgeTranscriptSummaryOptions,
): BridgeTranscriptSummaryUpdate {
  const limit = boundedInteger(
    options.limit,
    BRIDGE_TRANSCRIPT_MAX_MESSAGES,
    BRIDGE_TRANSCRIPT_MAX_MESSAGES,
  );
  const targetBytes = boundedInteger(
    options.targetBytes,
    BRIDGE_TRANSCRIPT_TARGET_BYTES,
    BRIDGE_TRANSCRIPT_TARGET_BYTES,
  );
  // The representation is part of the token: a v1 token must never answer a
  // v2 read as unchanged, or the reader would keep raw bodies it never asked for.
  const token = `s2${bridgeTranscriptToken({ ...options, limit, targetBytes }, messages as unknown[])}`;
  if (options.knownToken === token) return { version: 2, status: "unchanged", token };

  const candidates = messages.slice(-limit).map((message) => summarizeBridgeMessage(message));
  const bounded = boundTranscriptResponse(
    candidates as Array<{ content: string; parts: unknown[] }>,
    targetBytes,
    { envelopeReserveBytes: 0, contentFallbackBytes: 64 * 1024 },
  );
  const startIndex = messages.length - bounded.messages.length;
  const omittedMessages = startIndex;
  const windowTruncated = bounded.messageWindow.truncated || omittedMessages > 0;
  // Pages serve whole messages before `startIndex`. A part-trimmed head is
  // reported by `omittedParts` and is not something a page can restore.
  const historyCursor =
    options.pages && startIndex > 0
      ? encodePageCursor({
          g: String(options.generation),
          e: String(options.contentEpoch),
          b: startIndex,
        })
      : undefined;
  return {
    version: 2,
    status: "snapshot",
    token,
    value: {
      messages: bounded.messages,
      startIndex,
      complete: options.complete && !windowTruncated,
      messageWindow: {
        truncated: !options.complete || windowTruncated,
        ...(windowTruncated
          ? {
              truncationReason:
                messages.length > limit && candidates.length === bounded.messages.length
                  ? ("count" as const)
                  : ("bytes" as const),
              ...(omittedMessages > 0 ? { omittedMessages } : {}),
              ...(bounded.messageWindow.omittedParts
                ? { omittedParts: bounded.messageWindow.omittedParts }
                : {}),
            }
          : {}),
      },
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      generation: options.generation,
      contentEpoch: options.contentEpoch,
      freshness: options.freshness ?? "current",
      ...(options.title ? { title: options.title } : {}),
      ...(historyCursor ? { historyCursor } : {}),
      capabilities: { details: true, pages: options.pages === true },
    },
  };
}

// ---------------------------------------------------------------------------
// Pages

interface PageCursorBody {
  /** Bridge generation the positions belong to. */
  g: string;
  /** Content epoch the positions belong to. */
  e: string;
  /** Exclusive end position of the requested page. */
  b: number;
}

const PAGE_CURSOR_PREFIX = "bp1.";

function encodePageCursor(body: PageCursorBody): string | undefined {
  const cursor = PAGE_CURSOR_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url");
  return cursor.length <= BRIDGE_PAGE_CURSOR_MAX_LENGTH ? cursor : undefined;
}

function decodePageCursor(cursor: string): PageCursorBody | undefined {
  if (
    typeof cursor !== "string" ||
    !cursor.startsWith(PAGE_CURSOR_PREFIX) ||
    cursor.length > BRIDGE_PAGE_CURSOR_MAX_LENGTH
  ) {
    return undefined;
  }
  try {
    const body = JSON.parse(
      Buffer.from(cursor.slice(PAGE_CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as unknown;
    if (!isRecord(body)) return undefined;
    const { g, e, b } = body;
    if (typeof g !== "string" || typeof e !== "string") return undefined;
    if (!Number.isSafeInteger(b) || (b as number) <= 0) return undefined;
    return { g, e, b: b as number };
  } catch {
    return undefined;
  }
}

export interface BridgeTranscriptPageOptions {
  generation: string | number;
  contentEpoch: string | number;
  /** Whether history before `messages[0]` was ever lost within this epoch. */
  complete: boolean;
  cursor: string;
  limit: number;
  targetBytes: number;
}

/**
 * The summaries immediately before a cursor's position.
 *
 * A cursor names a position within one generation and content epoch; any
 * other epoch answers `expired` rather than guessing where that position went.
 * Every page either advances the cursor or ends history, including a page cut
 * to its byte target, so a reader can never loop.
 */
export function bridgeTranscriptPage(
  messages: readonly unknown[],
  options: BridgeTranscriptPageOptions,
): BridgeTranscriptPageResponse {
  const cursor = decodePageCursor(options.cursor);
  if (!cursor) return { version: 1, status: "invalid" };
  if (
    cursor.g !== String(options.generation) ||
    cursor.e !== String(options.contentEpoch) ||
    cursor.b > messages.length
  ) {
    return { version: 1, status: "expired" };
  }
  const limit = boundedInteger(options.limit, BRIDGE_PAGE_MAX_MESSAGES, 100);
  const targetBytes = boundedInteger(options.targetBytes, BRIDGE_PAGE_TARGET_BYTES, 512 * 1024);
  const end = cursor.b;
  const start = Math.max(0, end - limit);
  const candidates = messages.slice(start, end).map((message) => summarizeBridgeMessage(message));
  const bounded = boundTranscriptResponse(
    candidates as Array<{ content: string; parts: unknown[] }>,
    targetBytes,
    { envelopeReserveBytes: 0, contentFallbackBytes: 64 * 1024 },
  );
  const firstIndex = end - bounded.messages.length;
  const nextCursor =
    firstIndex > 0 ? encodePageCursor({ g: cursor.g, e: cursor.e, b: firstIndex }) : undefined;
  return {
    version: 1,
    status: "page",
    messages: bounded.messages,
    startIndex: firstIndex,
    ...(nextCursor ? { nextCursor } : {}),
    complete: firstIndex === 0 && options.complete,
    truncated: Boolean(bounded.messageWindow.omittedParts) || bounded.overflowed,
    generation: options.generation,
    contentEpoch: options.contentEpoch,
  };
}

// ---------------------------------------------------------------------------
// Consumer-side validation

const MAX_ENVELOPE_MESSAGES = 1_000;

/**
 * Parse a bridge's summary envelope, or undefined when it is not one.
 *
 * Callers pass whatever came back from a `version=2` request. An older bridge
 * ignores the parameter and answers v1, which is not an error: the caller
 * falls back to reading that body as v1. Anything else malformed is.
 */
export function parseBridgeTranscriptSummaryUpdate(
  body: unknown,
): BridgeTranscriptSummaryUpdate | undefined {
  if (!isRecord(body) || body.version !== BRIDGE_TRANSCRIPT_SUMMARY_VERSION) return undefined;
  if (typeof body.token !== "string" || body.token.length === 0 || body.token.length > 512) {
    return undefined;
  }
  if (body.status === "unchanged") return { version: 2, status: "unchanged", token: body.token };
  if (body.status !== "snapshot" || !isRecord(body.value)) return undefined;
  const value = body.value;
  if (!Array.isArray(value.messages) || value.messages.length > MAX_ENVELOPE_MESSAGES) {
    return undefined;
  }
  if (!Number.isSafeInteger(value.startIndex) || (value.startIndex as number) < 0) return undefined;
  if (!(typeof value.generation === "string" || Number.isSafeInteger(value.generation))) {
    return undefined;
  }
  if (!(typeof value.contentEpoch === "string" || Number.isSafeInteger(value.contentEpoch))) {
    return undefined;
  }
  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const window = isRecord(value.messageWindow) ? value.messageWindow : {};
  const count = (field: unknown) =>
    Number.isSafeInteger(field) && (field as number) > 0 ? (field as number) : undefined;
  const omittedMessages = count(window.omittedMessages);
  const omittedParts = count(window.omittedParts);
  return {
    version: 2,
    status: "snapshot",
    token: body.token,
    value: {
      messages: value.messages,
      startIndex: value.startIndex as number,
      complete: value.complete === true,
      messageWindow: {
        truncated: window.truncated === true,
        ...(window.truncationReason === "count" || window.truncationReason === "bytes"
          ? { truncationReason: window.truncationReason }
          : {}),
        ...(omittedMessages ? { omittedMessages } : {}),
        ...(omittedParts ? { omittedParts } : {}),
      },
      ...(Number.isSafeInteger(value.revision) ? { revision: value.revision as number } : {}),
      generation: value.generation as string | number,
      contentEpoch: value.contentEpoch as string | number,
      freshness: value.freshness === "cached" ? "cached" : "current",
      ...(typeof value.title === "string" && value.title.trim()
        ? { title: value.title.trim() }
        : {}),
      ...(typeof value.historyCursor === "string" &&
      value.historyCursor.length <= BRIDGE_PAGE_CURSOR_MAX_LENGTH
        ? { historyCursor: value.historyCursor }
        : {}),
      capabilities: {
        details: capabilities.details === true,
        pages: capabilities.pages === true,
      },
    },
  };
}

export function parseBridgeTranscriptDetailResponse(
  body: unknown,
): BridgeTranscriptDetailResponse | undefined {
  if (!isRecord(body) || body.version !== BRIDGE_TRANSCRIPT_DETAIL_VERSION) return undefined;
  if (
    body.status === "missing" ||
    body.status === "expired" ||
    body.status === "too-large" ||
    body.status === "invalid"
  ) {
    return { version: 1, status: body.status };
  }
  if (body.status !== "ok" || !isRecord(body.detail)) return undefined;
  const detail = body.detail;
  const payload: BridgeDetailPayload = {};
  if (typeof detail.toolOutput === "string") payload.toolOutput = detail.toolOutput;
  if (typeof detail.toolError === "string") payload.toolError = detail.toolError;
  if (isRecord(detail.toolDiff)) payload.toolDiff = detail.toolDiff;
  if (typeof detail.fileDataUrl === "string" && detail.fileDataUrl.startsWith("data:image/")) {
    payload.fileDataUrl = detail.fileDataUrl;
  }
  if (Object.keys(payload).length === 0) return undefined;
  return {
    version: 1,
    status: "ok",
    detail: payload,
    bytes: Number.isSafeInteger(body.bytes) ? (body.bytes as number) : 0,
  };
}

export function parseBridgeTranscriptPageResponse(
  body: unknown,
): BridgeTranscriptPageResponse | undefined {
  if (!isRecord(body) || body.version !== BRIDGE_TRANSCRIPT_PAGE_VERSION) return undefined;
  if (body.status === "expired" || body.status === "invalid") {
    return { version: 1, status: body.status };
  }
  if (body.status !== "page" || !Array.isArray(body.messages)) return undefined;
  if (body.messages.length > BRIDGE_PAGE_MAX_MESSAGES) return undefined;
  if (!Number.isSafeInteger(body.startIndex) || (body.startIndex as number) < 0) return undefined;
  if (!(typeof body.generation === "string" || Number.isSafeInteger(body.generation))) {
    return undefined;
  }
  if (!(typeof body.contentEpoch === "string" || Number.isSafeInteger(body.contentEpoch))) {
    return undefined;
  }
  const nextCursor =
    typeof body.nextCursor === "string" && body.nextCursor.length <= BRIDGE_PAGE_CURSOR_MAX_LENGTH
      ? body.nextCursor
      : undefined;
  // A page that claims more history but starts at zero, or that neither
  // advances nor ends, would loop a reader forever.
  if (nextCursor !== undefined && (body.startIndex as number) === 0) return undefined;
  if (nextCursor === undefined && (body.startIndex as number) > 0) return undefined;
  return {
    version: 1,
    status: "page",
    messages: body.messages,
    startIndex: body.startIndex as number,
    ...(nextCursor ? { nextCursor } : {}),
    complete: body.complete === true,
    truncated: body.truncated === true,
    generation: body.generation as string | number,
    contentEpoch: body.contentEpoch as string | number,
  };
}
