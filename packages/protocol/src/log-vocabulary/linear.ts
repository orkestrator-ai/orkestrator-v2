import { defineLogAreas } from "./define.js";

export const LINEAR_LOG_AREAS = defineLogAreas({
  linear: {
    description:
      "Linear issues read for build actions, project board links and the Linear connection across machines.",
    events: {
      "board-link.conflict":
        "Two of this machine's projects were linked to one Linear board on different machines; the link changed last kept it and the other was cleared.",
      "comments.load-failed":
        "An issue's comments could not be loaded; the issue still renders without them.",
      "connection.revoked-by-sync":
        "A disconnect made on another machine named this machine's Linear key, so it was cleared here.",
      "connection.exported-to-command-node":
        "An attached command node copied this machine's Linear key at the user's request (the key is not logged).",
      "sync.failed": "A Linear board-link sync with a node failed; it is retried on the next pass.",
      "sync.older-node": "A node does not sync Linear board links yet; it keeps its own links.",
    },
  },
});
