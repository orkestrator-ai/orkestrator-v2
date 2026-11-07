import { incompatibility } from "@orkestrator/protocol/contract/errors";
import type { DomainAdapterUsageRecorder } from "@orkestrator/protocol/contract/client";
import {
  DomainAdapterUsageRing,
  RECORD_DOMAIN_ADAPTER_USAGE_COMMAND,
  type DomainAdapterUsageEntry,
} from "@orkestrator/protocol/contract/client-usage";

/**
 * The renderer's domain client adapter counts (plan item 1009), next to the
 * content-free error ring (`renderer-error-ring.ts`) and uploaded the same
 * way, to this window's own backend, which adds them to its
 * compatibility-path counters (`domain-adapter.renderer.<domain>.v<version>`).
 *
 * An entry is a domain name, an adapter version and a count: no node,
 * command, argument or peer version. Only adapters below their domain's
 * current version are counted, so a renderer whose nodes are all current has
 * nothing to send and the upload stays idle (no timer).
 */
export const domainAdapterUsageRing = new DomainAdapterUsageRing();

/** The `usage` recorder renderer domain clients pass to `createDomainClient` (plan item 2011). */
export const recordDomainAdapterUsage: DomainAdapterUsageRecorder = (domain, version) => {
  try {
    domainAdapterUsageRing.record(domain, version);
  } catch {
    // Counting never fails a call.
  }
};

/** How long new counts wait before they are sent, and the longest a failing backend waits. */
export const DOMAIN_ADAPTER_USAGE_UPLOAD_INTERVAL_MS = 60_000;
export const DOMAIN_ADAPTER_USAGE_UPLOAD_MAX_INTERVAL_MS = 10 * 60_000;

interface UploadTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const browserTimer: UploadTimer = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Sends the ring's new counts one bounded batch at a time, at most once per
 * interval and only while there are counts to send. A failed send puts them
 * back and waits twice as long, up to the maximum; a backend that predates the
 * command (`unknown-command`) stops the upload for this load. Counts are kept
 * in memory only: a reload loses at most one interval of them, which the
 * retirement evidence tolerates.
 */
export function startDomainAdapterUsageUpload({
  ring = domainAdapterUsageRing,
  send,
  intervalMs = DOMAIN_ADAPTER_USAGE_UPLOAD_INTERVAL_MS,
  maxIntervalMs = DOMAIN_ADAPTER_USAGE_UPLOAD_MAX_INTERVAL_MS,
  timer = browserTimer,
}: {
  ring?: DomainAdapterUsageRing;
  send: (entries: DomainAdapterUsageEntry[]) => Promise<unknown>;
  intervalMs?: number;
  maxIntervalMs?: number;
  timer?: UploadTimer;
}): () => void {
  let stopped = false;
  let handle: unknown = null;
  let sending = false;
  let delay = intervalMs;

  const schedule = () => {
    if (stopped || sending || handle !== null || !ring.hasUnsent()) return;
    handle = timer.set(() => void tick(), delay);
  };
  const tick = async () => {
    handle = null;
    if (stopped) return;
    sending = true;
    const batch = ring.takeUnsent();
    try {
      if (batch.length > 0) await send(batch);
      delay = intervalMs;
    } catch (error) {
      ring.restore(batch);
      if (incompatibility(error, RECORD_DOMAIN_ADAPTER_USAGE_COMMAND)?.code === "unknown-command") {
        stopped = true;
      }
      delay = Math.min(delay * 2, maxIntervalMs);
    }
    sending = false;
    schedule();
  };
  const unsubscribe = ring.subscribe(schedule);
  schedule();
  return () => {
    stopped = true;
    unsubscribe();
    if (handle !== null) timer.clear(handle);
    handle = null;
  };
}
