/**
 * Error taxonomy for the app-server transport.
 *
 * The distinction that matters most is **"definitely not executed"** versus
 * **"unknown"**. A prompt may only be auto-retried when the server explicitly
 * says it rejected the request; a transport failure is ambiguous and must be
 * reconciled against `thread/read` first, or the same turn can run twice and
 * duplicate command executions and file edits.
 */
import type { EngineError, EngineGeneration } from "../engine/types.js";

/** app-server's documented "ingress queue full, safe to retry" code. */
export const APP_SERVER_OVERLOAD_CODE = -32001;

/** Standard JSON-RPC codes we special-case. */
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** A well-formed JSON-RPC error response: the server rejected this request. */
export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method: string;

  constructor(method: string, body: JsonRpcErrorBody) {
    super(`${method} failed (${body.code}): ${body.message}`);
    this.name = "AppServerRpcError";
    this.code = body.code;
    this.data = body.data;
    this.method = method;
  }

  /**
   * Only an explicit overload response is safe to retry blindly: the server has
   * told us it did not accept the request.
   */
  isOverload(): boolean {
    return this.code === APP_SERVER_OVERLOAD_CODE;
  }
}

/**
 * No response arrived within the method's budget. The request may or may not
 * have executed, so this is ambiguous.
 */
export class AppServerTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs}ms`);
    this.name = "AppServerTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The child exited (or was restarted) with this request in flight. Ambiguous:
 * the write may have landed before the process died.
 */
export class AppServerProcessExitError extends Error {
  readonly generation: EngineGeneration;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly method?: string;

  constructor(
    message: string,
    options: {
      generation: EngineGeneration;
      exitCode?: number | null;
      signal?: string | null;
      method?: string;
    },
  ) {
    super(message);
    this.name = "AppServerProcessExitError";
    this.generation = options.generation;
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
    this.method = options.method;
  }
}

/** The peer sent something that is not a valid JSON-RPC envelope. */
export class AppServerProtocolError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`app-server protocol violation: ${detail}`);
    this.name = "AppServerProtocolError";
    this.detail = detail;
  }
}

/** The engine is not in a state that can accept requests (failed, draining...). */
export class AppServerUnavailableError extends Error {
  readonly state: string;

  constructor(state: string, detail?: string) {
    super(detail ? `app-server is ${state}: ${detail}` : `app-server is ${state}`);
    this.name = "AppServerUnavailableError";
    this.state = state;
  }
}

/**
 * Repeated startup failures inside the rolling window. Reported through health
 * as a terminal failure rather than restarting forever.
 */
export class AppServerCircuitOpenError extends Error {
  readonly failures: number;

  constructor(failures: number, lastError?: string) {
    super(
      `app-server failed to start ${failures} times; not retrying${lastError ? ` (last error: ${lastError})` : ""}`,
    );
    this.name = "AppServerCircuitOpenError";
    this.failures = failures;
  }
}

/**
 * How a failed dispatch may be handled.
 *
 * - `rejected`  — the server said no; the turn definitely did not start.
 * - `ambiguous` — we do not know; reconcile via `thread/read` before retrying.
 */
export type DispatchFailureClass = "rejected" | "ambiguous";

export function classifyDispatchFailure(error: unknown): DispatchFailureClass {
  if (error instanceof AppServerRpcError) {
    // A structured error response means the request was parsed and refused.
    // Overload explicitly states it was not enqueued.
    return "rejected";
  }
  // Timeouts, process exits, write failures and protocol violations all leave
  // open the possibility that the server acted on the request.
  return "ambiguous";
}

/** True when the *same* request id may be re-sent without reconciliation. */
export function isSafeToRetryImmediately(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.isOverload();
}

/**
 * `thread/read(includeTurns=true)` on a thread whose first turn never
 * materialized fails instead of returning an empty turn list:
 *
 *   -32600 "thread <id> is not materialized yet; includeTurns is unavailable
 *            before first user message"
 *
 * Recovery depends on distinguishing this from a genuine read failure. It proves
 * no `userMessage` was ever persisted, so an ambiguous first dispatch definitely
 * did not execute and can be re-sent exactly once. Verified against the pinned
 * binary in `live-contract.test.ts`.
 */
export function isUnmaterializedThreadError(error: unknown): boolean {
  if (!(error instanceof AppServerRpcError)) return false;
  return /not materialized/i.test(error.message);
}

/**
 * A resume attempt against a rollout that no longer exists on disk. The bridge
 * falls back to reconstructing context in a fresh thread — but only for this,
 * never for a transient process error.
 */
export function isMissingRolloutError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = message.toLowerCase();
  return normalized.includes("thread/resume") && normalized.includes("no rollout found for thread id");
}

export function toEngineError(error: unknown): EngineError {
  if (error instanceof AppServerRpcError) {
    return {
      message: error.message,
      code: String(error.code),
      retryable: error.isOverload(),
      details: typeof error.data === "string" ? error.data : undefined,
    };
  }
  if (error instanceof AppServerTimeoutError) {
    return { message: error.message, code: "timeout", retryable: false };
  }
  if (error instanceof AppServerProcessExitError) {
    return { message: error.message, code: "process-exit", retryable: false };
  }
  if (error instanceof AppServerProtocolError) {
    return { message: error.message, code: "protocol", retryable: false };
  }
  if (error instanceof AppServerUnavailableError) {
    return { message: error.message, code: "unavailable", retryable: false };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

/**
 * Maps app-server's `CodexErrorInfo` discriminant onto a stable code string.
 * Preserved internally so the UI can keep showing usage-limit and
 * context-window messages distinctly, even though the transport is new.
 */
export function codexErrorInfoToCode(info: unknown): string | undefined {
  if (typeof info === "string") return info;
  if (info && typeof info === "object") {
    const keys = Object.keys(info as Record<string, unknown>);
    return keys.length === 1 ? keys[0] : undefined;
  }
  return undefined;
}
