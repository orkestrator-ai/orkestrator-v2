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
  revision: number;
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
      Authorization: `Bearer ${client.authToken}`,
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
