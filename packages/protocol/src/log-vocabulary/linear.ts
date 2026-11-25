import { defineLogAreas } from "./define.js";

export const LINEAR_LOG_AREAS = defineLogAreas({
  linear: {
    description:
      "Linear issues read for build actions, project board links and the Linear connection across machines.",
    events: {
      "board-link.conflict":
        "Two of this machine's projects were linked to one Linear board on different machines; the link changed last kept it and the other was cleared.",
      "build-files.failed":
        "None of a Linear-sourced build's ticket files could be downloaded; the Build prompt says why.",
      "build-files.prepared":
        "A Linear-sourced build's ticket files were downloaded into its workspace, with the counts downloaded and failed.",
      "comments.load-failed":
        "An issue's comments could not be loaded; the issue still renders without them.",
      "completion-comment.failed":
        "Posting a queued completion comment to a Linear issue failed; the reason is logged and it is retried later.",
      "completion-comment.posted": "A queued completion comment was posted to its Linear issue.",
      "completion-comment.queue-failed":
        "A completion comment could not be queued, or the queue could not be read.",
      "completion-comment.queue-full":
        "A completion comment was not queued because too many are already waiting.",
      "completion-comment.queued":
        "A Linear-sourced build could not post its completion comment, so it was queued; the reason is logged.",
      "completion-comment.status-failed":
        "A queued completion comment was posted but its build pipeline could not be updated to say so.",
      "connection.revoked-by-sync":
        "A disconnect made on another machine named this machine's Linear key, so it was cleared here.",
      "connection.exported-to-command-node":
        "An attached command node copied this machine's Linear key at the user's request (the key is not logged).",
      "merged-label.applied":
        "A Linear-sourced build's pull request merged and its issue now has the `merged` label (added, created then added, or already there).",
      "merged-label.failed":
        "Adding the `merged` label to a merged build's Linear issue failed; the reason is logged and it is retried later.",
      "merged-label.queue-full":
        "Legacy queue-capacity warning, no longer emitted: pending merged-label obligations are retained.",
      "merged-label.record-failed":
        "A merged pull request's Linear-sourced builds could not be read or queued for the `merged` label.",
      "merged-label.waiting":
        "A merged build's Linear issue waits for its `merged` label because this machine has no Linear connection; its command node or a connection made here lands it.",
      "relay.failed":
        "The Linear labels and comments a node owes could not be claimed or reported back; retried on the next pass.",
      "relay.older-node":
        "A node does not hand over the Linear labels and comments it owes yet; it keeps them.",
      "relay.write-failed":
        "A label or comment this command node tried to write to Linear for a node failed; the node retries it later.",
      "relay.written": "This command node wrote a node's owed labels and comments to Linear.",
      "sync.failed": "A Linear board-link sync with a node failed; it is retried on the next pass.",
      "sync.older-node": "A node does not sync Linear board links yet; it keeps its own links.",
    },
  },
});
