import { defineLogAreas } from "./define.js";

export const WEB_CLAUDE_TMUX_LOG_AREAS = defineLogAreas({
  "web.claude-tmux": {
    description: "The renderer's Claude tmux chat tab and interactive terminal.",
    events: {
      "sessions.list-failed": "The resume dialog could not list tmux sessions.",
    },
  },
});
