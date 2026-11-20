import { useEffect } from "react";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useNodeScope } from "@/lib/node-scope/providers";
import { createSignal, type WritableSignal } from "@/lib/node-scope/signal";
import { createSessionKey } from "@/lib/utils";
import type { Environment } from "@/types";

export interface UnreadResultRead {
  activityAt: string;
  sessionId: string;
}

const views = new WeakMap<NodeScope, WritableSignal<ReadonlyMap<string, UnreadResultRead>>>();

export function isUnreadFinishReason(reason: unknown): boolean {
  return reason === "agent_finished" || reason === "terminal_finished";
}

/** The newest matching unread session that still has a tab in the restored layout. */
export function finishedUnreadTabId(
  environment: Environment,
  tabs: readonly { id: string }[],
): string | undefined {
  if (!environment.hasUnreadWork || !isUnreadFinishReason(environment.unreadReason)) return;
  const keys = environment.unreadSessionEntries?.length
    ? environment.unreadSessionEntries
        .filter((entry) => entry.reason === environment.unreadReason)
        .map((entry) => entry.sessionKey)
    : environment.unreadSessionKeys;
  if (!keys?.length) return;
  const tabIds = new Map(tabs.map(({ id }) => [createSessionKey(environment.id, id), id]));
  for (let i = keys.length - 1; i >= 0; i--) {
    const tabId = tabIds.get(keys[i]!);
    if (tabId) return tabId;
  }
}

export function renderedUnreadResults(scope: NodeScope) {
  let signal = views.get(scope);
  if (!signal) {
    signal = createSignal<ReadonlyMap<string, UnreadResultRead>>(new Map());
    views.set(scope, signal);
  }
  return signal;
}

export function unreadResultActivityAt(
  environment:
    Pick<Environment, "unreadSessionEntries" | "unreadSessionKeys" | "lastActivityAt"> | undefined,
  sessionKey: string,
): string | undefined {
  const entry = environment?.unreadSessionEntries?.find((item) => item.sessionKey === sessionKey);
  if (entry) return entry.activityAt;
  if (environment?.unreadSessionKeys?.includes(sessionKey)) {
    return environment.lastActivityAt ?? new Date(0).toISOString();
  }
  return undefined;
}

/** Report only a committed view of the matching conversation. */
export function useRenderedUnreadResult(sessionKey: string, read: UnreadResultRead | undefined) {
  const scope = useNodeScope();
  useEffect(() => {
    if (!read) return;
    const views = renderedUnreadResults(scope);
    views.set(new Map(views.get()).set(sessionKey, read));
    return () => {
      const current = views.get();
      if (current.get(sessionKey) !== read) return;
      const next = new Map(current);
      next.delete(sessionKey);
      views.set(next);
    };
  }, [scope, sessionKey, read]);
}
