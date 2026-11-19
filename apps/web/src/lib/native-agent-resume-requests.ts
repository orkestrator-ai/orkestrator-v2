/**
 * "Open this agent tab resuming conversation X": a request parked by a
 * caller that creates the tab (the ⌘K palette's past sessions) for the tab
 * to read when it mounts.
 *
 * The tab then takes the same path as its own "Resume session" picker
 * (`SharedNativeAgentController`'s resume handler): it creates no provider
 * session of its own while the request is pending, waits until the caller
 * reports the tab saved, and resumes the chosen conversation. A request
 * nobody reads expires, so it can never resume a conversation into a tab
 * opened later.
 *
 * Renderer-only and bounded. It carries identifiers, never content. Tab ids
 * are only unique on their node, so requests are keyed by node too.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

export interface NativeAgentResumeRequestRef {
  nodeId: string;
  environmentId: string;
  tabId: string;
}

export interface NativeAgentResumeRequest {
  platform: AgentPlatform;
  /** The resumable session id the picker would have passed. */
  sessionId: string;
  /**
   * Settles once the caller has saved the new tab: true when saved. The tab
   * resumes only after `true`, as a picker-chosen resume waits for its lock to
   * be saved; on `false` it opens the picker instead.
   */
  ready: Promise<boolean>;
  expiresAt: number;
}

export const NATIVE_AGENT_RESUME_REQUEST_TTL_MS = 60_000;
export const MAX_NATIVE_AGENT_RESUME_REQUESTS = 16;

const requests = new Map<string, NativeAgentResumeRequest>();

function requestKey(ref: NativeAgentResumeRequestRef): string {
  return `${ref.nodeId}\u0000${ref.environmentId}\u0000${ref.tabId}`;
}

function prune(now: number): void {
  for (const [key, request] of Array.from(requests)) {
    if (request.expiresAt <= now) requests.delete(key);
  }
}

/** Parks a request for the tab `ref` names, replacing any earlier one for it. */
export function parkNativeAgentResumeRequest(
  ref: NativeAgentResumeRequestRef,
  request: Omit<NativeAgentResumeRequest, "expiresAt">,
  now = Date.now(),
): void {
  prune(now);
  const key = requestKey(ref);
  requests.delete(key);
  requests.set(key, { ...request, expiresAt: now + NATIVE_AGENT_RESUME_REQUEST_TTL_MS });
  while (requests.size > MAX_NATIVE_AGENT_RESUME_REQUESTS) {
    const oldest = requests.keys().next().value;
    if (oldest === undefined) break;
    requests.delete(oldest);
  }
}

/** The tab's unexpired request, if any, without consuming it. */
export function peekNativeAgentResumeRequest(
  ref: NativeAgentResumeRequestRef,
  now = Date.now(),
): NativeAgentResumeRequest | null {
  const request = requests.get(requestKey(ref));
  return request && request.expiresAt > now ? request : null;
}

/** Drops the tab's request, but only if it is still `request`. */
export function clearNativeAgentResumeRequest(
  ref: NativeAgentResumeRequestRef,
  request?: NativeAgentResumeRequest,
): void {
  const key = requestKey(ref);
  if (request === undefined || requests.get(key) === request) requests.delete(key);
}

/** Test helper: forget every request. */
export function resetNativeAgentResumeRequests(): void {
  requests.clear();
}
