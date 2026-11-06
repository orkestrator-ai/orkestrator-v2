import { createLogger } from "@orkestrator/protocol/logger";
import {
  parseRealmBootTimingMessage,
  REALM_BOOT_TIMING_MESSAGE,
} from "@orkestrator/protocol/realm-boot-timing";

const log = createLogger("workspaces");

export function isRealmBootTimingMessage(message: Record<string, unknown>): boolean {
  return message.type === REALM_BOOT_TIMING_MESSAGE;
}

/**
 * Write one realm boot step to the saved log, the only way a renderer's
 * timing reaches it (renderer logger lines stay in its console). The step's
 * fields are re-parsed against the fixed shape, and the node comes from the
 * main process's own binding for that realm, never from the message.
 */
export function logRealmBootTiming(
  message: unknown,
  realm: { nodeId: string; nodeName: string; sinceOpenMs: number | null },
): void {
  const timing = parseRealmBootTimingMessage(message);
  if (!timing) return;
  log.info("realm.boot-step", {
    nodeId: realm.nodeId,
    nodeName: realm.nodeName,
    step: timing.step,
    durationMs: timing.durationMs,
    ...(timing.sinceStartMs === undefined ? {} : { sinceStartMs: timing.sinceStartMs }),
    ...(realm.sinceOpenMs === null ? {} : { sinceOpenMs: realm.sinceOpenMs }),
    ...(timing.outcome === undefined ? {} : { outcome: timing.outcome }),
    ...(timing.requests === undefined ? {} : { requests: timing.requests }),
  });
}
