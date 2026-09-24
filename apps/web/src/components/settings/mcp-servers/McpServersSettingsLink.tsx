import { Server } from "lucide-react";

import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { Button } from "@/components/ui/button";
import { requestMcpServerSettings } from "@/lib/mcp-settings-navigation";

/** Entry point from a platform's settings into its saved MCP servers. */
export function McpServersSettingsLink({
  platform,
  environmentId,
}: {
  platform: AgentPlatform;
  environmentId?: string;
}) {
  const label = AGENT_PLATFORM_LABELS[platform];
  return (
    <div className="space-y-2 rounded-md border border-white/10 p-3">
      <div>
        <h4 className="text-sm font-medium text-foreground">MCP servers</h4>
        <p className="mt-1 text-xs text-muted-foreground/80">
          Add, edit and remove the MCP servers {label} connects to. This is separate from Control
          MCP, which lets agents control Orkestrator.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-1.5"
        onClick={() =>
          requestMcpServerSettings({
            provider: platform,
            ...(environmentId ? { environmentId } : {}),
          })
        }
      >
        <Server className="h-3.5 w-3.5" aria-hidden="true" /> Manage {label} MCP servers
      </Button>
    </div>
  );
}
