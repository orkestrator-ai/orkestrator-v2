import { defineLogAreas, ESSENTIAL_ERROR_FIELDS, THROTTLE_LOG_EVENTS } from "./define.js";

export const STORAGE_LOG_AREAS = defineLogAreas({
  storage: {
    description: "The SQLite-backed stores, their snapshots and imports from older formats.",
    events: {
      "usage.environment-label-failed":
        "Usage labels could not be retained for a removed environment; deletion continues.",
      "migration.failed": {
        description:
          "The database could not be brought to this build's schema, so it did not open; `step` says whether the safety copy or the migration itself failed.",
        essential: true,
        fields: {
          fromVersion: "number",
          toVersion: "number",
          step: "label",
          ...ESSENTIAL_ERROR_FIELDS,
        },
      },
      "snapshot.integrity-failed": {
        description: "A database snapshot failed its integrity check and was discarded.",
        essential: true,
        fields: {},
      },
      "snapshot.skipped-low-disk":
        "The hourly database snapshot was skipped because the disk lacks room; `retryAt` says when it tries again.",
      "snapshot.failed": {
        description:
          "The hourly database snapshot failed; `retryAt` says when it tries again, if known.",
        essential: true,
        fields: { retryAt: "label", ...ESSENTIAL_ERROR_FIELDS },
      },
      "listener.attention-failed":
        "An environment attention listener threw; the committed mutation stands.",
      "listener.change-failed": "A resource change listener threw; the committed mutation stands.",
      "kanban.image-cleanup-failed":
        "An orphaned Kanban image could not be removed after its retries; it is safe to remove later.",
      "nodes.entries-dropped": "Unreadable node registry entries were ignored.",
      "preview-identity.reminted":
        "The data directory moved or was copied, so previews get a new backend identity.",
      "preview-settings.invalid": "Invalid preview settings disabled transport and relay.",
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
      "config.restrict-mode-failed":
        "A config file holding provider secrets could not be set to owner-only; the backend carries on.",
      "legacy-json.moved":
        "JSON store files written after the SQLite migration were archived, not imported.",
      "legacy-json.archive-failed": "Imported JSON store files could not be archived.",
      "native-session-owners.backfill-failed":
        "Native-session rows could not be given their environment as owner at open; an environment delete then parses those rows instead, and the next open retries.",
      "lease.timed-out":
        "A waiter gave up on a lease; `lease` and `family` name it, `holderAgeMs` is the time since its holder's last heartbeat (null when the holder had just gone), `waitedMs` how long the waiter waited.",
      "lease.heartbeat-failed":
        "A held lease's heartbeat failed, which shortens the lease; the next one retries.",
      "scrub.checkpoint-failed":
        "Deleted content could not be scrubbed from the WAL yet because the truncating checkpoint failed or a reader held an older snapshot; it is retried without waiting until it succeeds.",
      "upkeep.vacuum-failed": "Periodic page reclamation failed; the next upkeep pass retries.",
      "upkeep.finished":
        "One periodic upkeep pass ended: `optimizeMs` is how long refreshing planner statistics held the event loop, `released` and `left` the free pages returned and still free, `releaseMs` the release child's run and `stop` why it ended (`done`, `budget`, `busy`, `no-progress`, `slow-step`, `not-incremental`, `no-free-pages`, `failed`).",
      "operation.slow": {
        description:
          "A synchronous SQLite call or transaction held the event loop for at least 250 ms. `database` is `main` or `ledger`, `op` the statement kind or `transaction`, `table` its table (a transaction's slowest statement's), `durationMs` the whole call; a transaction adds `mode`, `beginMs` (waiting for the write lock), `sqlMs` (its statements) and `commitMs`. `busy` means the busy timeout ran out. Repeats of one series within 10 s are folded into the next line.",
        essential: true,
        fields: {
          database: "label",
          op: "label",
          table: "label",
          mode: "label",
          durationMs: "number",
          beginMs: "number",
          sqlMs: "number",
          commitMs: "number",
          busy: "boolean",
          folded: "number",
          foldedMaxMs: "number",
        },
      },
      "optimize.failed":
        "Refreshing the query planner's statistics failed; queries still run and the next check retries.",
      "ledger.moved":
        "The change-tracking ledger was moved out of the main database into its own file; `rows` and `durationMs` say how much and how long.",
      "snapshot.top-tables-failed":
        "The sampled table sizes from a finished snapshot could not be saved; the snapshot stands and the next one retries.",
      "snapshot.ledger-skipped":
        "The daily change-tracking ledger snapshot was skipped because the disk or the snapshot budget lacks room; `retryAt` says when it tries again.",
      "snapshot.ledger-failed":
        "The daily change-tracking ledger snapshot failed; `retryAt` says when it tries again, if known.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});
