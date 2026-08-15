import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import type { PromptAttachment } from "./prompt-attachments.js";
import {
  type BridgeConnection,
  PromptRejectedError,
  type ProviderSendOptions,
  ProviderUnavailableError,
} from "./agent-provider-contract.js";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";

const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;
const ACP_SESSION_START_TIMEOUT_MS = 75_000;

export interface HttpBridgeProviderDependencies {
  fetch?: typeof fetch;
  stageImages?: (
    images: NonNullable<ProviderSendOptions["images"]>,
  ) => Promise<PromptAttachment[]>;
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
  const headers = new Headers({ "Content-Type": "application/json" });
  if (connection.agent === "claude") {
    headers.set("X-Orkestrator-Claude-Token", connection.authToken);
  } else if (connection.agent === "codex") {
    headers.set("X-Orkestrator-Codex-Token", connection.authToken);
  } else if (connection.agent === "cursor" || connection.agent === "grok") {
    headers.set("Authorization", `Bearer ${connection.authToken}`);
  }
  return headers;
}

function bridgeRequestTimeoutMs(
  connection: BridgeConnection,
  kind: "default" | "session-start" = "default",
): number {
  if (connection.requestTimeoutMs !== undefined) {
    return Math.max(1, connection.requestTimeoutMs);
  }
  if (
    kind === "session-start"
    && (connection.agent === "cursor" || connection.agent === "grok")
  ) {
    return ACP_SESSION_START_TIMEOUT_MS;
  }
  return DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS;
}

export async function bridgeFetch(
  connection: BridgeConnection,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  timeoutKind: "default" | "session-start" = "default",
): Promise<Response> {
  const headers = authHeaders(connection);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const timeoutMs = bridgeRequestTimeoutMs(connection, timeoutKind);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetchImpl(`${connection.baseUrl}${path}`, {
      ...init,
      headers,
      signal,
    });
  } catch (error) {
    throw new ProviderUnavailableError(
      `${connection.agent} bridge is unavailable`,
      { cause: error },
    );
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
  const detail = rawDetail
    ? rawDetail.replace(/[\r\n\t]+/g, " ").slice(0, 500)
    : "";
  const message = `${operation} ${isTransientHttpStatus(response.status)
    ? "is temporarily unavailable"
    : "failed"} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`;
  if (isTransientHttpStatus(response.status)) {
    throw new ProviderUnavailableError(message);
  }
  throw new Error(message);
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 408
    || status === 425
    || status === 429
    || status >= 500;
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
    attachments.push(...await stageImages(images));
  }
  return attachments.length > 0 ? attachments : undefined;
}
