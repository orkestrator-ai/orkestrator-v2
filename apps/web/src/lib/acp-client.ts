import type { NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
import { EMPTY_NATIVE_AGENT_COMPOSER_STATE } from "@orkestrator/protocol/native-agent";
import { resolveGatewayLoopbackBaseUrl } from "./gateway-url";
import type { NativeMessage } from "./chat/native-message-types";

export type AcpProvider = "cursor" | "grok";

export type AcpMessage = NativeMessage;

export interface AcpSessionSnapshot {
  id: string;
  provider: AcpProvider;
  status: "idle" | "running" | "error";
  error?: string;
  messages: AcpMessage[];
  /** Absolute index of `messages[0]`; advances as the bridge evicts history. */
  baseIndex: number;
  revision: number;
  composer: NativeAgentComposerState;
}

/** An incremental slice of the transcript, anchored to an absolute index. */
export interface AcpMessageWindow {
  messages: AcpMessage[];
  baseIndex: number;
  totalMessages: number;
  revision: number;
  status: "idle" | "running" | "error";
  error?: string;
  composer?: NativeAgentComposerState;
}

export interface AcpApproval {
  id: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
}

export interface AcpClient {
  baseUrl: string;
  authToken: string;
}

export function createAcpClient(baseUrl: string, authToken: string): AcpClient {
  return { baseUrl: resolveGatewayLoopbackBaseUrl(baseUrl), authToken };
}

async function request<T>(client: AcpClient, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${client.baseUrl}${pathname}`, {
    ...init,
    headers: {
      // The public gateway owns Authorization. A dedicated header preserves
      // the per-bridge credential through that authenticated proxy hop and is
      // also accepted by direct local ACP bridges.
      "X-Orkestrator-Acp-Token": client.authToken,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error || `ACP bridge request failed (${response.status})`);
  return body as T;
}

export function createAcpSession(client: AcpClient): Promise<AcpSessionSnapshot> {
  return request(client, "/session/create", { method: "POST" });
}

export function getAcpSession(client: AcpClient, sessionId: string): Promise<AcpSessionSnapshot> {
  return request<AcpSessionSnapshot>(client, `/session/${encodeURIComponent(sessionId)}`).then(
    (session) => ({ ...session, composer: normalizeAcpComposer(session.composer) }),
  );
}

/**
 * Read the transcript from `fromIndex` onward. Only the trailing message
 * mutates as chunks stream in, so callers re-request their own last index and
 * receive that message plus anything newer instead of the whole transcript.
 */
export function getAcpMessageWindow(
  client: AcpClient,
  sessionId: string,
  fromIndex: number,
): Promise<AcpMessageWindow> {
  return request<AcpMessageWindow>(
    client,
    `/session/${encodeURIComponent(sessionId)}/messages?fromIndex=${Math.max(0, Math.trunc(fromIndex))}`,
    // A window is an incremental update, so an absent or unusable `composer`
    // means "no news" — a bridge old enough not to send one must not blank the
    // caller's picker. Only a full snapshot substitutes the empty composer.
  ).then((window) => ({ ...window, composer: optionalAcpComposer(window.composer) }));
}

/**
 * Merge an incremental window into the messages a caller already holds. The
 * window's `baseIndex` is authoritative: if the bridge evicted more history
 * than the caller knows about, the window replaces the list outright.
 */
export function mergeAcpMessageWindow(
  current: { messages: AcpMessage[]; baseIndex: number },
  window: AcpMessageWindow,
): { messages: AcpMessage[]; baseIndex: number } {
  const keep = window.baseIndex - current.baseIndex;
  if (keep <= 0 || keep > current.messages.length) {
    return { messages: window.messages, baseIndex: window.baseIndex };
  }
  return {
    messages: [...current.messages.slice(0, keep), ...window.messages],
    baseIndex: current.baseIndex,
  };
}

export function sendAcpPrompt(client: AcpClient, sessionId: string, prompt: string): Promise<void> {
  return request(client, `/session/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
}

export function getAcpModels(client: AcpClient): Promise<NativeAgentComposerState["models"]> {
  return request<{ models?: NativeAgentComposerState["models"] }>(client, "/global/models").then(
    (response) => (Array.isArray(response.models) ? response.models : []),
  );
}

export function setAcpSessionConfig(
  client: AcpClient,
  sessionId: string,
  patch: {
    modelId?: string;
    reasoningId?: string;
    fastMode?: boolean;
    mode?: "build" | "plan";
  },
): Promise<NativeAgentComposerState> {
  return request<NativeAgentComposerState>(
    client,
    `/session/${encodeURIComponent(sessionId)}/config`,
    {
      method: "POST",
      body: JSON.stringify(patch),
    },
  ).then((composer) => normalizeAcpComposer(composer));
}

export function normalizeAcpComposer(
  value: NativeAgentComposerState | undefined | null,
): NativeAgentComposerState {
  return (
    optionalAcpComposer(value) ?? { ...EMPTY_NATIVE_AGENT_COMPOSER_STATE, models: [], modes: [] }
  );
}

/** `undefined` when there is nothing usable, so callers can keep what they hold. */
export function optionalAcpComposer(
  value: NativeAgentComposerState | undefined | null,
): NativeAgentComposerState | undefined {
  if (!value || !Array.isArray(value.models) || !Array.isArray(value.modes)) return undefined;
  return value;
}

export function cancelAcpPrompt(client: AcpClient, sessionId: string): Promise<void> {
  return request(client, `/session/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
}

export function getAcpApprovals(client: AcpClient, sessionId: string): Promise<AcpApproval[]> {
  return request<{ approvals: AcpApproval[] }>(
    client,
    `/session/${encodeURIComponent(sessionId)}/approvals`,
  ).then((response) => response.approvals);
}

export function resolveAcpApproval(
  client: AcpClient,
  sessionId: string,
  approvalId: string,
  optionId?: string,
): Promise<void> {
  return request(
    client,
    `/session/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: "POST",
      body: JSON.stringify(optionId ? { optionId } : {}),
    },
  );
}

export function deleteAcpSession(client: AcpClient, sessionId: string): Promise<void> {
  return request(client, `/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}
