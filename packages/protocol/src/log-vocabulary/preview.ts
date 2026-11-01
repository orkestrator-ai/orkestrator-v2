import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const PREVIEW_LOG_AREAS = defineLogAreas({
  preview: {
    description: "Browser and service previews: transports, partitions and captures.",
    events: {
      "attachment.release-failed": "Releasing a preview attachment failed; its lease expires it.",
      "capture-spool.load-failed": "The pending browser capture spool could not be loaded.",
      "certificate.refresh-failed":
        "Re-reading the preview certificate failed; the next check retries.",
      "certificate.renewal-refused":
        "A renewed certificate does not cover the preview hosts, so it was ignored.",
      "connection-cleanup.record-failed": "A forgotten connection's cleanup could not be recorded.",
      "link.open-external-failed": "A preview link could not be opened in the system browser.",
      "node.record-failed": "A node that owns preview partitions could not be recorded.",
      "partition.clear-failed": "A preview partition could not be cleared.",
      "partitions.record-cleared-failed": "Cleared preview partitions could not be recorded.",
      "partitions.record-nodes-failed": "The nodes that own preview partitions could not be saved.",
      "partitions.remove-failed": "Cleared preview partition directories could not be removed.",
      "partitions.retry-forgotten-failed": "Retrying a forgotten preview cleanup failed.",
      "port-hints.persist-failed": "Preview port hints could not be saved.",
      "transport.close-failed": "A preview transport could not be closed.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});
