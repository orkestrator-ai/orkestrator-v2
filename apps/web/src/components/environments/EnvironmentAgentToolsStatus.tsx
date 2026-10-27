import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContainerHostReachabilityDialog,
  useContainerHostReachability,
} from "@/components/docker/ContainerHostReachabilityNotice";

/**
 * Whether this container environment's agents can reach Orkestrator's agent
 * tools server, from the backend's host check. Shown only when they cannot:
 * the app-wide banner can be hidden, and a rootless Docker daemon makes this
 * every container's state until its host loopback is enabled.
 */
export function EnvironmentAgentToolsStatus() {
  const { value, checking, recheck } = useContainerHostReachability();
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!value || value.status !== "blocked") return null;
  return (
    <div
      role="status"
      data-testid="environment-agent-tools-status"
      className="space-y-2 rounded-md border border-amber-500/40 p-3 text-xs text-muted-foreground"
    >
      <div className="flex items-center gap-2 font-medium text-foreground">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        Agent tools unavailable
      </div>
      <div>
        {value.dockerRootless
          ? "Docker runs rootless and refuses connections from containers to this computer, so this environment's agents can't submit review results, send mail or update tickets."
          : "A firewall on this computer blocks Docker containers, so this environment's agents can't submit review results, send mail or update tickets."}
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
        How to fix
      </Button>
      <ContainerHostReachabilityDialog
        value={value}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        checking={checking}
        onRecheck={() => void recheck()}
      />
    </div>
  );
}
