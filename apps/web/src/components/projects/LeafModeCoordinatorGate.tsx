import { useEffect, useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "zustand";
import { portalStore } from "@/lib/portal/portal-store";

/**
 * In leaf mode this node's coordinator is not the project's coordinator:
 * coordination happens on the command node above. Its conversations are
 * kept, since they may hold important information, but they stay behind
 * this warning until the user chooses to open them for this session.
 */
export function LeafModeCoordinatorGate({ children }: { children: ReactNode }) {
  const status = useStore(portalStore.store, (state) => state.status);
  const [opened, setOpened] = useState(false);
  // A leaf workspace realm does not run the portal; it still reads its own node's mode.
  useEffect(() => {
    if (!portalStore.getState().loaded) void portalStore.refresh();
  }, []);
  if (!status || status.mode !== "leaf" || opened) return <>{children}</>;
  const controllers = status.controllers.map((entry) => entry.displayName).join(", ");
  return (
    <div
      id="project-panel-coordinator"
      role="tabpanel"
      className="flex h-full items-center justify-center p-6"
      data-testid="leaf-mode-coordinator-gate"
    >
      <div className="max-w-md space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
        <p className="flex items-center gap-2 font-medium text-amber-100">
          <ShieldAlert className="h-4 w-4" /> This node is in leaf mode
        </p>
        <p className="text-muted-foreground">
          It is controlled by {controllers}. Coordination for this project happens there, not here.
          This node&apos;s own coordinator conversations are kept, but its coordinator does not act
          across nodes while this node is controlled.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpened(true)}>
          Open this node&apos;s coordinator anyway
        </Button>
      </div>
    </div>
  );
}
