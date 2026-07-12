import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { forceResolveSetupRuntime } from "@/lib/setup-commands";

interface SetupPendingOverlayProps {
  environmentId: string;
  /** Short agent-specific message, e.g. "Claude will connect automatically once setup finishes" */
  subtext: string;
}

/**
 * Shared waiting-for-setup UI with a manual "Skip setup wait" override.
 *
 * The override calls forceResolveSetupRuntime, which flips the runtime gates
 * without persisting completion. Use this when the normal detection path
 * (OSC marker or workspace-ready text marker) fails to fire. The button shows
 * an inline confirmation before firing because clicking it while setup is
 * genuinely still running will connect the agent against a half-initialized
 * workspace.
 */
export function SetupPendingOverlay({ environmentId, subtext }: SetupPendingOverlayProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
      <Loader2 className="w-8 h-8 animate-spin text-yellow-400" />
      <p className="text-sm">Waiting for setup scripts to complete...</p>
      <p className="text-xs">{subtext}</p>
      {confirming ? (
        <div className="mt-2 flex flex-col items-center gap-2">
          <p className="text-xs max-w-xs text-center">
            Skipping may connect the agent before setup finishes. Only use this
            if setup detection appears to be stuck.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="text-xs"
              onClick={() => forceResolveSetupRuntime(environmentId)}
            >
              Skip anyway
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 text-xs text-muted-foreground"
          onClick={() => setConfirming(true)}
        >
          Skip setup wait
        </Button>
      )}
    </div>
  );
}
