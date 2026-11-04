import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const LOCAL_SERVER_LOG_AREAS = defineLogAreas({
  "local-server": {
    description: "Agent bridge processes the backend runs on the host.",
    events: {
      "bridge.not-answering":
        "A bridge with work in progress fails health checks, so it is not restarted yet.",
      "bridge-runtime.installing": "A bridge runtime is being installed.",
      "bridge-runtime.installed": "A bridge runtime finished installing.",
      "opencode.database-lost-retrying":
        "OpenCode lost its shared database at startup, so it is retried.",
      "server.stopping": "A local server is being stopped, for the fixed `reason` given.",
      "bridge.started": {
        description: "A local bridge process was spawned; `key` names its kind and environment.",
        essential: true,
        fields: { key: "label", pid: "number" },
      },
      "bridge.exited": {
        description:
          "A local bridge process exited, with its `code` and `signal`. `warn` when nothing asked it to, whatever the code; `info` when the backend stopped it, which `server.stopping` explains.",
        essential: true,
        fields: {
          key: "label",
          pid: "number",
          code: "number",
          signal: "label",
          requested: "boolean",
        },
      },
      "reaper.tmux-list-failed": "Orphaned claude-tmux sessions could not be listed.",
      "reaper.tmux-kill-failed": "An orphaned tmux session could not be killed.",
      "reaper.tmux-reaped": "Orphaned claude-tmux sessions of a deleted environment were killed.",
      "reaper.runtime-root-remove-failed":
        "A claude-tmux runtime root could not be removed; it stays for a retry.",
      "reaper.server-unidentified":
        "An orphan candidate could not be identified, so its record is kept.",
      "reaper.server-refused": "An orphan candidate leads no process group, so it was not reaped.",
      "reaper.server-reaping": "An orphaned server is being stopped.",
      "reaper.server-kill-failed": "An orphaned server did not exit.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});
