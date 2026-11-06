import { isRealmBootTimingMessage, logRealmBootTiming } from "./realm-boot-timing-log.js";

interface RealmMessageViews {
  viewForWebContents(senderId: number): { scope: string } | null | undefined;
  msSinceOpened(senderId: number): number | null;
  post(senderId: number, message: Record<string, unknown>): void;
}

/** Main-process realm channel: timing is consumed locally, never forwarded. */
export function postFromWorkspaceRealm(
  senderId: number | undefined,
  message: Record<string, unknown>,
  views: RealmMessageViews,
  realmBindings: ReadonlyMap<string, { target: { nodeId: string; nodeName: string } | null }>,
): void {
  if (senderId === undefined) throw new Error("Only a workspace realm can message its window.");
  if (isRealmBootTimingMessage(message)) {
    const record = views.viewForWebContents(senderId);
    const target = record ? realmBindings.get(record.scope)?.target : null;
    // Diagnostic messages can race eviction/close; an unbound sender has no
    // trusted node attribution, so discard its timing instead of failing IPC.
    if (!target) return;
    logRealmBootTiming(message, {
      nodeId: target.nodeId,
      nodeName: target.nodeName,
      sinceOpenMs: views.msSinceOpened(senderId),
    });
    return;
  }
  views.post(senderId, message);
}
