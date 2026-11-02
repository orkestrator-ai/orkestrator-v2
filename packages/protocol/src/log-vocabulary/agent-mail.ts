import { defineLogAreas } from "./define.js";

export const AGENT_MAIL_LOG_AREAS = defineLogAreas({
  "agent-mail": {
    description: "Delivering agent mail into waiting agent sessions.",
    events: {
      "delivery.waiting":
        "The drain passed over a pending message, for a reason it had not yet logged.",
      "drain.new-mail-failed": "Draining newly received mail failed; the next sweep delivers it.",
      "presence.sync-failed": "Mailboxes could not be synchronized.",
      "inject.verified": "An injected message's delivery was checked. Ids and decisions only.",
      "inject.dispatched": "Messages were dispatched into a session. Ids and decisions only.",
      "stopped-worker.action-failed": "Nothing could act on mail for a stopped worker.",
      "coordinator.start-failed": "The main coordinator could not be started for a new message.",
      "message.placed":
        "A message was placed in a mailbox. Ids and decisions only, never subjects or bodies.",
      "budget.hold-notify-failed": "The coordinator could not be told about held worker mail.",
      "budget.reset-failed": "The mail budget could not be reset for a prompted tab.",
    },
  },
});
