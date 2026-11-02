import { defineLogAreas } from "./define.js";

export const STORAGE_LOG_AREAS = defineLogAreas({
  storage: {
    description: "The SQLite-backed stores, their snapshots and imports from older formats.",
    events: {
      "usage.environment-label-failed":
        "Usage labels could not be retained for a removed environment; deletion continues.",
      "snapshot.integrity-failed":
        "An hourly database snapshot failed its integrity check and was discarded.",
      "snapshot.skipped-low-disk":
        "The hourly database snapshot was skipped because the disk lacks room; `retryAt` says when it tries again.",
      "snapshot.failed":
        "The hourly database snapshot failed; `retryAt` says when it tries again, if known.",
      "listener.attention-failed":
        "An environment attention listener threw; the committed mutation stands.",
      "listener.change-failed": "A resource change listener threw; the committed mutation stands.",
      "kanban.image-cleanup-failed":
        "An orphaned Kanban image could not be removed after its retries; it is safe to remove later.",
      "nodes.entries-dropped": "Unreadable node registry entries were ignored.",
      "preview-identity.reminted":
        "The data directory moved or was copied, so previews get a new backend identity.",
      "machine-profile.invalid":
        "The stored machine profile was invalid and the default was restored.",
      "permission-rules.cleanup-failed":
        "A deleted project's permission rules could not be removed.",
      "retired.turn-cleanup-pending":
        "Cleanup of a retired Looped Review turn did not finish and stays pending.",
      "handoffs.prune-failed":
        "Pruning agent handoffs that nothing references failed; a later prune retries.",
      "desktop-connections.malformed":
        "Stored desktop connection settings were malformed, so the local connection is used.",
      "legacy-json.moved":
        "JSON store files written after the SQLite migration were archived, not imported.",
      "legacy-json.archive-failed": "Imported JSON store files could not be archived.",
    },
  },
});
