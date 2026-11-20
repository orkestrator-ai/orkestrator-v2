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
   * be saved; on failure the tab can retry the save for the same conversation.
   */
  ready: Promise<boolean>;
  expiresAt: number;
}

export interface NativeAgentResumeIntent {
  ref: NativeAgentResumeRequestRef;
  request: NativeAgentResumeRequest;
}

export const NATIVE_AGENT_RESUME_REQUEST_TTL_MS = 60_000;
export const MAX_NATIVE_AGENT_RESUME_REQUESTS = 16;

interface ParkedResume {
  request: NativeAgentResumeRequest;
  observed: boolean;
  saving?: Promise<boolean>;
  execution?: Promise<void>;
}

const requests = new Map<string, ParkedResume>();

function requestKey(ref: NativeAgentResumeRequestRef): string {
  return `${ref.nodeId}\u0000${ref.environmentId}\u0000${ref.tabId}`;
}

function prune(now: number): void {
  for (const [key, { request, observed }] of Array.from(requests)) {
    if (!observed && request.expiresAt <= now) requests.delete(key);
  }
}

/** Parks a request for the tab `ref` names, replacing any earlier one for it. */
export function parkNativeAgentResumeRequest(
  ref: NativeAgentResumeRequestRef,
  request: Omit<NativeAgentResumeRequest, "expiresAt">,
  now = Date.now(),
): boolean {
  prune(now);
  const key = requestKey(ref);
  if (requests.get(key)?.observed) return false;
  if (!requests.has(key) && requests.size >= MAX_NATIVE_AGENT_RESUME_REQUESTS) {
    const oldest = Array.from(requests).find(([, parked]) => !parked.observed);
    if (!oldest) return false;
    requests.delete(oldest[0]);
  }
  // This may settle before the new tab has mounted to observe it.
  void request.ready.catch(() => undefined);
  requests.delete(key);
  requests.set(key, {
    request: { ...request, expiresAt: now + NATIVE_AGENT_RESUME_REQUEST_TTL_MS },
    observed: false,
  });
  return true;
}

/** The tab's unexpired request, if any, without consuming it. */
export function peekNativeAgentResumeRequest(
  ref: NativeAgentResumeRequestRef,
  now = Date.now(),
): NativeAgentResumeRequest | null {
  const parked = requests.get(requestKey(ref));
  return parked && (parked.observed || parked.request.expiresAt > now) ? parked.request : null;
}

/** The tab is waiting for its save. Preserve the request until it settles or the tab closes. */
export function observeNativeAgentResumeRequest(
  ref: NativeAgentResumeRequestRef,
  request: NativeAgentResumeRequest,
): boolean {
  const parked = requests.get(requestKey(ref));
  if (!parked || parked.request !== request) return false;
  parked.observed = true;
  return true;
}

/** Drops the tab's request, but only if it is still `request`. */
export function clearNativeAgentResumeRequest(
  ref: NativeAgentResumeRequestRef,
  request?: NativeAgentResumeRequest,
): boolean {
  const key = requestKey(ref);
  return (request === undefined || requests.get(key)?.request === request) && requests.delete(key);
}

/**
 * Claims a saved tab's request once. If the view remounts while adoption is
 * in flight, it waits on the same promise before enabling session creation.
 */
export function runNativeAgentResumeRequest(
  ref: NativeAgentResumeRequestRef,
  request: NativeAgentResumeRequest,
  run: () => Promise<void>,
): Promise<void> | undefined {
  const parked = requests.get(requestKey(ref));
  if (!parked || parked.request !== request) return undefined;
  parked.execution ??= run().finally(() => clearNativeAgentResumeRequest(ref, request));
  return parked.execution;
}

/** Retry the same save, including across a remount while it is in flight. */
export function retryNativeAgentResumeSave(
  ref: NativeAgentResumeRequestRef,
  request: NativeAgentResumeRequest,
  save: () => Promise<void>,
): Promise<boolean> | undefined {
  const parked = requests.get(requestKey(ref));
  if (!parked || parked.request !== request) return undefined;
  parked.saving ??= Promise.resolve()
    .then(save)
    .then(
      () => true,
      () => false,
    )
    .finally(() => {
      parked.saving = undefined;
    });
  parked.request.ready = parked.saving;
  return parked.saving;
}

/** Release requests when their owning scope is disposed. */
export function clearNativeAgentResumeRequestsForNode(nodeId: string): void {
  for (const key of Array.from(requests.keys())) {
    if (key.startsWith(`${nodeId}\u0000`)) requests.delete(key);
  }
}

/** Test helper: forget every request. */
export function resetNativeAgentResumeRequests(): void {
  requests.clear();
}
