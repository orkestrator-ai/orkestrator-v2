import { useState } from "react";
import { Paintbrush } from "lucide-react";
import type { CreatableTabType, CreateTabOptions } from "@/contexts/TerminalContext";
import { Button } from "@/components/ui/button";
import { DesignWorkspaceDialog } from "./DesignWorkspaceDialog";

/**
 * Toolbar entry for design workspaces. It stays focusable and enabled whenever
 * an environment is selected: renderer health, tab capacity and environment
 * state are explained inside the dialog instead of hiding everything behind a
 * disabled button. Readiness is only probed when the dialog opens.
 */
export function DesignLaunchButton({
  environmentId,
  createTab,
}: {
  environmentId?: string;
  /**
   * Retained for callers; tab capacity no longer disables the entry because an
   * already-open design can always be focused and the library browsed.
   */
  disabled?: boolean;
  tabCount?: number;
  createTab: ((type: CreatableTabType, options?: CreateTabOptions) => boolean) | null;
}) {
  const [open, setOpen] = useState(false);
  // Mount the dialog on first use so the toolbar does no design work until
  // asked, then keep it mounted so a draft brief survives closing.
  const [used, setUsed] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label="New design workspace"
        title="Design workspace"
        disabled={!environmentId}
        onClick={() => {
          setUsed(true);
          setOpen(true);
        }}
      >
        <Paintbrush className="size-4" />
      </Button>
      {environmentId && used && (
        <DesignWorkspaceDialog
          open={open}
          onOpenChange={setOpen}
          environmentId={environmentId}
          createTab={createTab}
        />
      )}
    </>
  );
}
