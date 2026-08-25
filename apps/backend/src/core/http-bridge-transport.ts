import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import type { PromptAttachment } from "./prompt-attachments.js";
import {
  type BridgeConnection,
  PromptRejectedError,
  type ProviderSendOptions,
  ProviderUnavailableError,
  ProviderUnreachableError,
} from "./agent-provider-contract.js";
import { asRecord, isTransientHttpStatus, nonEmptyString } from "./agent-provider-runtime.js";

const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
const ACP_SESSION_START_TIMEOUT_MS = 75_000;
/**
 * Prompt dispatch and session attach share one budget, because they do the same
 * work.
 *
 * A bridge whose agent process is not attached performs the full cold start on
 * whichever request arrives first: spawn, `initialize`, `session/load`, and any
 * composer RPCs, each with its own 30s ceiling on the bridge side. Session
 * creation was already given 75s for exactly this reason; capping the prompt
 * request at the 30s default meant a cold dispatch could be aborted mid-flight
 * and reported to the user as an unresolvable ambiguous dispatch, even though
 * the bridge went on to run the turn. Attach is budgeted the same because it is
 * that cold start, just outside the at-most-once window.
 */
const BRIDGE_ATTACH_TIMEOUT_MS = 90_000;

/**
 * Which ceiling a request gets. `prompt` and `attach` are separate names for
 * the same budget so call sites read as what they do.
 */
export type BridgeRequestTimeoutKind = "default" | "session-start" | "attach" | "prompt";

/**
 * Transport failures that are proven to precede the first written byte.
 *
 * Bun reports a refused connection *and* a failed DNS lookup as
 * `code: "ConnectionRefused"`; Node/undici wraps the underlying `cause` with a
 * POSIX code. Both are listed because the backend runs on Bun while tests and
 * embedders may supply a Node `fetch`. Nothing that can occur after the request
 * headers are on the wire belongs here — `ECONNRESET`, a truncated response and
 * a timeout all stay ambiguous.
 */
const CONNECT_PHASE_ERROR_CODES = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ERR_SOCKET_BAD_PORT",
]);

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * True when the request provably never reached the bridge.
 *
 * Deliberately conservative: an unrecognised failure is treated as though the
 * bridge may have seen it. Guessing the other way would let a prompt that did
 * run be reported as never sent, and the caller would dispatch it twice.
 */
export function isConnectPhaseFailure(error: unknown): boolean {
  const direct = errorCode(error);
  if (direct && CONNECT_PHASE_ERROR_CODES.has(direct)) return true;
  const cause =
    typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  const nested = errorCode(cause);
  return nested !== undefined && CONNECT_PHASE_ERROR_CODES.has(nested);
}

export interface HttpBridgeProviderDependencies {
  fetch?: typeof fetch;
  stageImages?: (images: NonNullable<ProviderSendOptions["images"]>) => Promise<PromptAttachment[]>;
}

export async function boundedJson(
  response: Response,
  operation: string,
  budget = { remaining: AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes },
): Promise<unknown> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderUnavailableError(`${operation} is oversized`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderUnavailableError(`${operation} is malformed`);
  }
}

function authHeaders(connection: BridgeConnection): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
    // This is a server-to-server fetch, so unlike a browser client it must
    // advertise compression explicitly. Fetch transparently decodes the body;
    // the byte guards below continue to measure the decoded JSON contract.
    "Accept-Encoding": "gzip",
  });
  if (connection.agent === "claude") {
    headers.set("X-Orkestrator-Claude-Token", connection.authToken);
  } else if (connection.agent === "codex") {
    headers.set("X-Orkestrator-Codex-Token", connection.authToken);
  } else if (
    connection.agent === "cursor" ||
    connection.agent === "grok" ||
    connection.agent === "pi"
  ) {
    headers.set("Authorization", `Bearer ${connection.authToken}`);
  }
  return headers;
}

function bridgeRequestTimeoutMs(
  connection: BridgeConnection,
  kind: BridgeRequestTimeoutKind = "default",
): number {
  if (connection.requestTimeoutMs !== undefined) {
    return Math.max(1, connection.requestTimeoutMs);
  }
  if (kind === "session-start" && (connection.agent === "cursor" || connection.agent === "grok")) {
    return ACP_SESSION_START_TIMEOUT_MS;
  }
  // Unlike session start this is not narrowed to the ACP agents: every bridge
  // can reattach a detached session on its prompt route, and none of them
  // benefits from the caller giving up while that work is still running.
  if (kind === "attach" || kind === "prompt") return BRIDGE_ATTACH_TIMEOUT_MS;
  return DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS;
}

export async function bridgeFetch(
  connection: BridgeConnection,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  timeoutKind: BridgeRequestTimeoutKind = "default",
): Promise<Response> {
  const headers = authHeaders(connection);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const timeoutMs = bridgeRequestTimeoutMs(connection, timeoutKind);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetchImpl(`${connection.baseUrl}${path}`, {
      ...init,
      headers,
      signal,
    });
  } catch (error) {
    // A bridge that was never reached is a different fact from one that stopped
    // answering mid-request, and prompt dispatch resolves the two differently.
    if (isConnectPhaseFailure(error)) {
      throw new ProviderUnreachableError(`${connection.agent} bridge is not reachable`, {
        cause: error,
      });
    }
    throw new ProviderUnavailableError(`${connection.agent} bridge is unavailable`, {
      cause: error,
    });
  }
}

export function assertOk(response: Response, operation: string): void {
  if (!response.ok) {
    if (isTransientHttpStatus(response.status)) {
      throw new ProviderUnavailableError(
        `${operation} is temporarily unavailable (HTTP ${response.status})`,
      );
    }
    throw new Error(`${operation} failed (HTTP ${response.status})`);
  }
}

export async function assertOkWithErrorDetail(
  response: Response,
  operation: string,
): Promise<void> {
  if (response.ok) return;
  const payload = await boundedJson(response, operation).catch(() => null);
  const rawDetail = nonEmptyString(asRecord(payload)?.error);
  const detail = rawDetail ? rawDetail.replace(/[\r\n\t]+/g, " ").slice(0, 500) : "";
  const message = `${operation} ${
    isTransientHttpStatus(response.status) ? "is temporarily unavailable" : "failed"
  } (HTTP ${response.status})${detail ? `: ${detail}` : ""}`;
  if (isTransientHttpStatus(response.status)) {
    throw new ProviderUnavailableError(message);
  }
  throw new Error(message);
}

/**
 * Produce the attachment list a bridge will accept.
 *
 * Base64-only images have no `path`, which every bridge validator requires, so
 * they must be staged first. Refusing them outright when no stager is wired is
 * deliberate: the alternative is a prompt that references an image the agent was
 * never given.
 */
export async function resolvePromptAttachments(
  options: ProviderSendOptions,
  stageImages: HttpBridgeProviderDependencies["stageImages"],
): Promise<PromptAttachment[] | undefined> {
  const attachments = options.attachments ? [...options.attachments] : [];
  const images = options.images ?? [];
  if (images.length > 0) {
    if (!stageImages) {
      throw new PromptRejectedError(
        "Prompt images require workspace staging before they can be attached",
      );
    }
    attachments.push(...(await stageImages(images)));
  }
  return attachments.length > 0 ? attachments : undefined;
}
