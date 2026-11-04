import { defineLogAreas } from "./define.js";

export const NODES_LOG_AREAS = defineLogAreas({
  nodes: {
    description: "Command nodes: links, handovers, leaf mail, ticket sync and project copies.",
    events: {
      "actions.resume-failed": "Approved actions could not be resumed; a later pass retries.",
      "project-copy.notify-failed": "The coordinator could not be told a project copy finished.",
      "notices.take-back-failed": "A notice for this node's coordinator stayed in the outbox.",
      "notice.collected-retired":
        "A detached controller owned a notice with ambiguous delivery; retired without redelivery.",
      "mail.delivery-deferred": "Leaf mail could not reach a coordinator yet.",
      "command.post-step-failed": "A step after a routed command failed.",
      "seed-files.incomplete": "Seed files for a leaf environment were not all copied.",
      "contact.record-failed": "The latest controller contact could not be recorded.",
      "settings.send-failed": "Settings could not be sent to a node.",
      "verification.record-failed": "A node verification could not be recorded.",
      "profile.record-failed": "A node profile could not be recorded.",
      "detach.unconfirmed": "A forgotten node has not confirmed the detach yet.",
      "handover.recovery-pending": "Command handover recovery is still pending.",
      "ticket-sync.work-record-failed":
        "A remote build started but its ticket work location could not be saved.",
      "ticket-sync.failed": "A Kanban sync with a node failed; it is retried.",
      "ticket-sync.unknown-project":
        "A node sent ticket changes for a project that no longer exists here.",
      "ticket-sync.forget-failed": "A detached command node's ticket copies could not be released.",
    },
  },
});
