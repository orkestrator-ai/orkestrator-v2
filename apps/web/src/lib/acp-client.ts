import type { NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
import { EMPTY_NATIVE_AGENT_COMPOSER_STATE } from "@orkestrator/protocol/native-agent";
import type { NodeTransport } from "./native/node-transport";
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

/**
 * What the ACP client needs of the transport of the node its bridge runs on:
 * where that node's gateway answers, and its bearer. Read per request, so a
 * credential swap (`setCredential`) reaches later requests.
 */
export type AcpNodeTransport = Pick<NodeTransport, "url" | "requestHeaders" | "requestCredentials">;

export interface AcpClient {
  /** Where requests go: the bridge itself, or its loopback proxy on the node's gateway. */
  baseUrl: string;
  authToken: string;
  /** The node transport whose gateway proxies the bridge; absent for a direct bridge. */
  transport?: AcpNodeTransport;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/** The gateway path that proxies a loopback bridge URL, or null for any other URL. */
export function acpLoopbackProxyPath(bridgeUrl: string): string | null {
  try {
    const url = new URL(bridgeUrl);
    if (!isLoopbackHost(url.hostname)) return null;
    const port = url.port || (url.protocol === "http:" ? "80" : "");
    if (!port) return null;
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `/__orkestrator/proxy/loopback/${port}${basePath}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/**
 * A client for the ACP bridge at `bridgeUrl`. With its node's `transport`, a
 * loopback bridge is reached through that node's gateway proxy with that
 * transport's bearer; nothing relies on a page-wide `fetch` patch or on
 * `window.orkestratorGateway`. Without one, the bridge is called directly.
 */
export function createAcpClient(
  bridgeUrl: string,
  authToken: string,
  transport?: AcpNodeTransport | null,
): AcpClient {
  const proxyPath = transport ? acpLoopbackProxyPath(bridgeUrl) : null;
  if (!transport || proxyPath === null) return { baseUrl: bridgeUrl, authToken };
  return { baseUrl: transport.url(proxyPath), authToken, transport };
}

async function request<T>(client: AcpClient, pathname: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    // The public gateway owns Authorization. A dedicated header preserves
    // the per-bridge credential through that authenticated proxy hop and is
    // also accepted by direct local ACP bridges.
    "X-Orkestrator-Acp-Token": client.authToken,
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const response = await fetch(`${client.baseUrl}${pathname}`, {
    ...init,
    ...(client.transport ? { credentials: client.transport.requestCredentials } : {}),
    // The node's bearer, for its gateway's authenticated proxy hop.
    headers: client.transport ? (client.transport.requestHeaders(headers) ?? headers) : headers,
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
