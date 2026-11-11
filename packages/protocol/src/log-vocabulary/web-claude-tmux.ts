import { defineLogAreas } from "./define.js";

export const WEB_CLAUDE_TMUX_LOG_AREAS = defineLogAreas({
  "web.claude-tmux": {
    description: "The renderer's Claude tmux chat tab and interactive terminal.",
    events: {
      "sessions.list-failed": "The resume dialog could not list tmux sessions.",
      "tab.hydrate-failed": "Reading a tab's tmux session from the backend failed.",
      "models.catalog-unavailable": "The model catalogue failed; the bundled fallback stays.",
      "queue.promote-failed":
        "After an interrupt, the next queued prompt did not become the draft.",
      "files.load-failed": "The file list for @mentions could not be loaded.",
      "clipboard.image-failed": "An image pasted into the interactive terminal could not be saved.",
      "terminal.resize-failed": "Resizing the interactive terminal's session failed.",
      "terminal.recover-failed": "The interactive terminal could not reattach to its session.",
      "terminal.lease-lapsed":
        "The backend had dropped the interactive terminal after missed renewals; a new one is attached.",
      "terminal.renew-failed":
        "Renewing the interactive terminal's lease failed; the next renewal retries.",
    },
  },
});
