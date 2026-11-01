import { ENVIRONMENT_ATTENTION_EVENT } from "@orkestrator/protocol/environment-attention";
import { RESOURCE_CHANGED_EVENT, type ResourceChange } from "@orkestrator/protocol/resource-events";
import type { BackendEmit } from "./commands-context.js";
import type { StorageService } from "./storage.js";

/**
 * Fans committed storage events out to every connected client.
 *
 * - Every committed mutation is announced as `resource-changed`, so a second
 *   window or browser converges without polling.
 * - Attention edges (an agent stopped, failed, waits or asks) go out as
 *   `environment-attention`, so no client infers them from badge flips.
 *
 * `emit` is read lazily by the caller's closure, which is how this survives the
 * gateway not existing yet. `onResourceChange` lets the backend observe the same
 * announcements (the node portal's self summary).
 */
export function installStorageEventFanout(
  storage: Pick<StorageService, "setResourceChangeListener" | "addEnvironmentAttentionListener">,
  emit: BackendEmit,
  onResourceChange: (change: ResourceChange) => void,
): void {
  storage.setResourceChangeListener((change) => {
    emit(RESOURCE_CHANGED_EVENT, change);
    onResourceChange(change);
  });
  storage.addEnvironmentAttentionListener((event) => emit(ENVIRONMENT_ATTENTION_EVENT, event));
}
