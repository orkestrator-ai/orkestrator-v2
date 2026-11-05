/**
 * Recovering an evicted provider-held tool detail (report 0110, TX-8).
 *
 * A summary row's heavy body stays with the provider behind a locator, and the
 * backend hands the renderer a reference minted from that locator. A raw row
 * has no locator, so its reference is hashed from the body. The two kinds of
 * reference never match, which is why a raw `sync-v1` refresh cannot rebuild
 * an evicted remote reference however much it reads.
 *
 * So remote references carry a prefix no inline reference can have (inline
 * ones are lowercase hex), and a miss on one is recovered from what the
 * backend already holds: the registrations its cached rows and direct history
 * pages kept, replayable without a body. Neither structure is new; both are
 * bounded by their own count and byte limits, and this only reads them.
 */
import { DEFAULT_NATIVE_AGENT_LIVE_WINDOW } from "@orkestrator/protocol/native-agent";
import type { NativeAgentLiveWindow } from "@orkestrator/protocol/native-agent";
import type { ProjectionDetailRegistration } from "./native-agent-projection-entries.js";

/** Marks a reference minted from a provider locator. Inline references are hex. */
export const REMOTE_DETAIL_REF_PREFIX = "r";

export function isRemoteDetailRef(detailRef: string): boolean {
  return detailRef.startsWith(REMOTE_DETAIL_REF_PREFIX);
}

/** What a remote reference needs to be registered again. */
export type RemoteDetailRegistration = NonNullable<ProjectionDetailRegistration["remote"]>;

/**
 * The registration behind `detailRef` among the given registration lists, or
 * undefined. A caller passes the session's cached rows and pages only.
 */
export function findRemoteDetailRegistration(
  detailRef: string,
  sources: Iterable<readonly ProjectionDetailRegistration[]>,
): RemoteDetailRegistration | undefined {
  for (const registrations of sources) {
    for (const registration of registrations) {
      if (registration.ref === detailRef && registration.remote) return registration.remote;
    }
  }
  return undefined;
}

/**
 * The live window a summary read should use to re-project the session's rows:
 * the one its most recently used progressive transcript view was read with,
 * so the read is the one a reader already shares, or the default window.
 */
export function recoveryLiveWindow(
  progressiveTranscriptKeys: Iterable<string>,
  sessionKey: string,
): NativeAgentLiveWindow {
  const prefix = `${sessionKey}\0progressive-v1\0transcript:`;
  let window: NativeAgentLiveWindow | undefined;
  for (const key of progressiveTranscriptKeys) {
    if (!key.startsWith(prefix)) continue;
    const [messages, targetBytes] = key.slice(prefix.length).split(":").map(Number);
    if (Number.isSafeInteger(messages) && Number.isSafeInteger(targetBytes)) {
      // Map order is least recently used first, so the last match wins.
      window = { messages: messages!, targetBytes: targetBytes! };
    }
  }
  return window ?? DEFAULT_NATIVE_AGENT_LIVE_WINDOW;
}
