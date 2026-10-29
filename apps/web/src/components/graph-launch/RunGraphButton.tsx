import { useState } from "react";
import { Play } from "lucide-react";
import type { CreatableTabType, CreateTabOptions } from "@/contexts/TerminalContext";
import { Button } from "@/components/ui/button";
import { GraphLaunchDialog } from "./GraphLaunchDialog";
import { openLaunchedGraphRun } from "./open-launched-run";

/**
 * "Run graph…" in the environment action bar (item 214, D17): opens the
 * launch dialog with the template picker, the current environment
 * preselected, and opens the run's tab here once it launches. The dialog is
 * mounted on first use, so the toolbar does no graph work until asked.
 */
export function RunGraphButton({
  environmentId,
  projectId,
  createTab,
  showLabel = false,
}: {
  environmentId?: string;
  projectId?: string | null;
  createTab: ((type: CreatableTabType, options?: CreateTabOptions) => boolean) | null;
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label="Run graph…"
        title="Run graph…"
        disabled={!environmentId || !projectId}
        onClick={() => {
          setUsed(true);
          setOpen(true);
        }}
      >
        <Play className="size-4" />
        {showLabel && <span className="truncate text-xs">Run graph…</span>}
      </Button>
      {used && environmentId && projectId && (
        <GraphLaunchDialog
          open={open}
          onOpenChange={setOpen}
          projectId={projectId}
          environmentId={environmentId}
          onLaunched={(result) => openLaunchedGraphRun({ result, createTab })}
        />
      )}
    </>
  );
}
