import { resolveGatewayLoopbackBaseUrl } from "./gateway-url";

export type AcpProvider = "cursor" | "grok";

export interface AcpMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: Array<{ type: "text" | "reasoning"; text: string }>;
  createdAt: string;
}

export interface AcpSessionSnapshot {
  id: string;
  provider: AcpProvider;
  status: "idle" | "running" | "error";
  error?: string;
  messages: AcpMessage[];
  /** Absolute index of `messages[0]`; advances as the bridge evicts history. */
  baseIndex: number;
  revision: number;
}

/** An incremental slice of the transcript, anchored to an absolute index. */
export interface AcpMessageWindow {
  messages: AcpMessage[];
  baseIndex: number;
  totalMessages: number;
  revision: number;
  status: "idle" | "running" | "error";
  error?: string;
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

async function request<T>(
  client: AcpClient,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
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
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `ACP bridge request failed (${response.status})`);
  return body as T;
}

export function createAcpSession(client: AcpClient): Promise<AcpSessionSnapshot> {
  return request(client, "/session/create", { method: "POST" });
}

export function getAcpSession(client: AcpClient, sessionId: string): Promise<AcpSessionSnapshot> {
  return request(client, `/session/${encodeURIComponent(sessionId)}`);
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
  return request(
    client,
    `/session/${encodeURIComponent(sessionId)}/messages?fromIndex=${Math.max(0, Math.trunc(fromIndex))}`,
  );
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

export function cancelAcpPrompt(client: AcpClient, sessionId: string): Promise<void> {
  return request(client, `/session/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
}

export function getAcpApprovals(client: AcpClient, sessionId: string): Promise<AcpApproval[]> {
  return request<{ approvals: AcpApproval[] }>(client, `/session/${encodeURIComponent(sessionId)}/approvals`)
    .then((response) => response.approvals);
}

export function resolveAcpApproval(
  client: AcpClient,
  sessionId: string,
  approvalId: string,
  optionId?: string,
): Promise<void> {
  return request(client, `/session/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    body: JSON.stringify(optionId ? { optionId } : {}),
  });
}

export function deleteAcpSession(client: AcpClient, sessionId: string): Promise<void> {
  return request(client, `/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}
