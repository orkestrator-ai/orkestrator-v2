import { defineLogAreas } from "./define.js";

export const MCP_LOG_AREAS = defineLogAreas({
  "control-mcp": {
    description: "The Control MCP server other agents and devices reach Orkestrator through.",
    events: {
      "listener.port-free": "The Control MCP's fixed port is free again, so it is listening.",
      "state-listener.failed": "A Control MCP state listener threw; the others still run.",
      "delegation.remote-open-failed": "A delegation could not be opened on another node.",
      "delegation.open-failed": "A coordinator delegation could not be opened.",
      "delegation.turn-origin-unreadable":
        "A coordinator's last turn origin could not be read, so its delegated prompt is marked as arising from agent mail.",
    },
  },
  "mcp-management": {
    description: "Managed MCP configuration: its commands, overlays and apply loop.",
    events: {
      "command.failed":
        "An MCP management command failed; `ref` is the correlation id shown to the user.",
      "overlay.materialise-failed": "An MCP overlay could not be written.",
      "apply.tick-failed": "An MCP apply tick failed; the next one retries.",
    },
  },
});
