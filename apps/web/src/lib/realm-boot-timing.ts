import { createLogger } from "@orkestrator/protocol/logger";
import {
  REALM_BOOT_TIMING_MESSAGE,
  type RealmBootStep,
  type RealmBootTimingMessage,
} from "@orkestrator/protocol/realm-boot-timing";
import { isWorkspaceRealm } from "@/lib/federation/workspace-realm";

export type { RealmBootStep } from "@orkestrator/protocol/realm-boot-timing";

const log = createLogger("web.startup");

/** Steps already reported by this document: each is a first occurrence only. */
const recorded = new Set<RealmBootStep>();

const sinceDocumentStart = () =>
  globalThis.performance ? globalThis.performance.now() : Number.NaN;

/**
 * Report one step of a workspace realm's boot to the desktop, once per realm
 * document.
 *
 * Renderer logger lines stay in the browser console, so the step crosses to
 * the desktop main process as a realm message instead, and the main process
 * writes it to the saved log with the realm's node (`workspaces`
 * `realm.boot-step`). The message carries only the step name, durations in
 * milliseconds, a fixed outcome and a request count: never a path, prompt,
 * token or identifier from the node's data. Outside a desktop realm (a window
 * of its own, a browser frame) it is a debug line in the console only.
 */
export function recordRealmBootStep(
  step: RealmBootStep,
  durationMs: number,
  detail: { outcome?: "ok" | "failed"; requests?: number } = {},
): void {
  if (recorded.has(step) || !isWorkspaceRealm()) return;
  recorded.add(step);
  const sinceStartMs = sinceDocumentStart();
  const message: RealmBootTimingMessage = {
    type: REALM_BOOT_TIMING_MESSAGE,
    step,
    durationMs: Math.max(0, Math.round(durationMs)),
    ...(Number.isFinite(sinceStartMs) ? { sinceStartMs: Math.round(sinceStartMs) } : {}),
    ...(detail.outcome ? { outcome: detail.outcome } : {}),
    ...(detail.requests !== undefined ? { requests: detail.requests } : {}),
  };
  log.debug("realm.boot-step", () => ({ ...message }));
  try {
    window.orkestrator?.workspaceRealm?.post(message);
  } catch {
    // Timing is diagnostic only; a closing realm must not fail its boot.
  }
}

/** Forget what this document reported, for tests. */
export function resetRealmBootTimingForTests(): void {
  recorded.clear();
}
