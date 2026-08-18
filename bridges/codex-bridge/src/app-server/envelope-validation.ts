/**
 * Runtime classification of inbound JSON-RPC envelopes.
 *
 * This runs inside the stdout reader, which is a latency-sensitive protocol loop
 * — app-server's outbound queue is bounded, so anything slow here stalls *every*
 * thread in the environment. Validation is therefore deliberately shallow and
 * synchronous: envelope shape only, no JSON Schema evaluation, no payload walk.
 * Deep validation belongs in the reducer, off this path.
 */
import { AppServerProtocolError } from "./errors.js";
import type { JsonRpcErrorBody } from "./errors.js";

export type JsonRpcId = string | number;

export interface InboundResponse {
  kind: "response";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

export interface InboundNotification {
  kind: "notification";
  method: string;
  params: unknown;
  /** app-server stamps this before fan-out; absent on older versions. */
  emittedAtMs?: number;
}

export interface InboundServerRequest {
  kind: "server-request";
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export interface InboundInvalid {
  kind: "invalid";
  detail: string;
  /** Truncated for logs; never the full payload, which may contain user data. */
  preview: string;
}

export type InboundMessage =
  | InboundResponse
  | InboundNotification
  | InboundServerRequest
  | InboundInvalid;

const PREVIEW_LIMIT = 200;

function preview(value: string): string {
  return value.length > PREVIEW_LIMIT ? `${value.slice(0, PREVIEW_LIMIT)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function parseErrorBody(value: unknown): JsonRpcErrorBody | null {
  if (!isRecord(value)) return null;
  const code = typeof value.code === "number" ? value.code : null;
  if (code === null) return null;
  return {
    code,
    message: typeof value.message === "string" ? value.message : "unknown error",
    data: value.data,
  };
}

/**
 * Classifies one already-parsed JSON value.
 *
 * Discrimination order matters. A message with both `id` and `method` is a
 * server-initiated *request* (it expects a response); `id` without `method` is a
 * response to us; `method` without `id` is a notification. Getting this wrong
 * would either leave app-server waiting forever for a response or resolve the
 * wrong pending promise.
 */
export function classifyInbound(value: unknown): InboundMessage {
  if (!isRecord(value)) {
    return {
      kind: "invalid",
      detail: "envelope is not an object",
      preview: preview(String(value)),
    };
  }

  const hasId = value.id !== undefined && value.id !== null;
  const hasMethod = typeof value.method === "string" && value.method.length > 0;

  if (hasId && hasMethod) {
    if (!isValidId(value.id)) {
      return {
        kind: "invalid",
        detail: "server request id must be a string or finite number",
        preview: preview(String(value.method)),
      };
    }
    return {
      kind: "server-request",
      id: value.id,
      method: value.method as string,
      params: value.params,
    };
  }

  if (hasId) {
    if (!isValidId(value.id)) {
      return {
        kind: "invalid",
        detail: "response id must be a string or finite number",
        preview: "",
      };
    }
    const errorBody = parseErrorBody(value.error);
    if (errorBody) return { kind: "response", id: value.id, error: errorBody };
    if (!("result" in value)) {
      return {
        kind: "invalid",
        detail: "response has neither result nor a well-formed error",
        preview: "",
      };
    }
    return { kind: "response", id: value.id, result: value.result };
  }

  if (hasMethod) {
    return {
      kind: "notification",
      method: value.method as string,
      params: value.params,
      emittedAtMs: typeof value.emittedAtMs === "number" ? value.emittedAtMs : undefined,
    };
  }

  return { kind: "invalid", detail: "envelope has neither id nor method", preview: "" };
}

/**
 * Parses one JSONL line. Returns an `invalid` message instead of throwing so a
 * single malformed line cannot tear down the reader for every thread.
 */
export function parseInboundLine(line: string): InboundMessage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "invalid", detail: "line is not valid JSON", preview: preview(trimmed) };
  }
  return classifyInbound(parsed);
}

/**
 * Notifications carry `threadId` at the top level of `params` for every
 * thread-scoped method. The reader uses this to pick a per-thread queue without
 * interpreting the payload.
 */
export function extractThreadId(params: unknown): string | null {
  if (!isRecord(params)) return null;
  if (typeof params.threadId === "string" && params.threadId.length > 0) return params.threadId;
  // `thread/started` nests the id inside the thread object.
  if (isRecord(params.thread) && typeof params.thread.id === "string") return params.thread.id;
  return null;
}

export function extractTurnId(params: unknown): string | null {
  if (!isRecord(params)) return null;
  if (typeof params.turnId === "string" && params.turnId.length > 0) return params.turnId;
  if (isRecord(params.turn) && typeof params.turn.id === "string") return params.turn.id;
  return null;
}

export function assertValidOutboundMethod(method: string): void {
  if (!method || typeof method !== "string") {
    throw new AppServerProtocolError("outbound method must be a non-empty string");
  }
}
