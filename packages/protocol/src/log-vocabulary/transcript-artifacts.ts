import { defineLogAreas } from "./define.js";

export const TRANSCRIPT_ARTIFACTS_LOG_AREAS = defineLogAreas({
  "transcript-artifacts": {
    description:
      "Transcript artifacts: previews, printing, grants and their ledger. Ids, kinds, sizes and reason codes only.",
    events: {
      "announce-failed": "An artifact change could not be announced.",
      "cleanup-failed": "An artifact cleanup failed.",
      "grant-revocation-failed": "A grant could not be revoked.",
      "ledger-listener-failed": "A ledger listener threw.",
      "ledger-read-failed": "The ledger could not be read.",
      "operation-executor-failed": "A preview operation's executor failed.",
      "operation-failed": "A preview operation failed.",
      "pdf-preview": "A PDF preview was served.",
      "pdf-preview-failed": "A PDF preview failed.",
      "pdf-print-failed": "Printing an artifact to PDF failed.",
      "pdf-printed": "An artifact was printed to PDF.",
      "runtime-unavailable": "The artifact runtime could not be created.",
    },
  },
});
