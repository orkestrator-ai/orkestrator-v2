import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { forceResolveSetupRuntime, retrySetupRuntime } from "@/lib/setup-commands";
import type { Environment } from "@/types";

interface SetupPendingOverlayProps {
  environmentId: string;
  setupPhase?: Environment["setupPhase"];
  /** Short agent-specific message, e.g. "Claude will connect automatically once setup finishes" */
  subtext: string;
}

/**
 * Shared waiting-for-setup UI with a manual "Skip setup wait" override.
 *
 * The override calls forceResolveSetupRuntime, which persists the backend
 * setup override. Use this when the normal detection path
 * (OSC marker or workspace-ready text marker) fails to fire. The button shows
 * an inline confirmation before firing because clicking it while setup is
 * genuinely still running will connect the agent against a half-initialized
 * workspace.
 */
export function SetupPendingOverlay({
  environmentId,
  setupPhase,
  subtext,
}: SetupPendingOverlayProps) {
  const [confirming, setConfirming] = useState(false);
  const [operation, setOperation] = useState<"retry" | "override" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failed = setupPhase === "failed";

  const runOperation = async (kind: "retry" | "override") => {
    setError(null);
    setOperation(kind);
    try {
      if (kind === "retry") {
        await retrySetupRuntime(environmentId);
      } else {
        await forceResolveSetupRuntime(environmentId);
        setConfirming(false);
      }
    } catch (operationError) {
      setError(
        operationError instanceof Error
          ? operationError.message
          : `Failed to ${kind === "retry" ? "retry" : "skip"} setup`,
      );
    } finally {
      setOperation(null);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
      {failed ? (
        <AlertTriangle className="h-8 w-8 text-destructive" />
      ) : (
        <Loader2 className="h-8 w-8 animate-spin text-yellow-400" />
      )}
      <p className="text-sm">
        {failed ? "Environment setup failed." : "Waiting for setup scripts to complete..."}
      </p>
      <p className="text-xs">{subtext}</p>
      {failed && !confirming && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 text-xs"
          disabled={operation !== null}
          onClick={() => void runOperation("retry")}
        >
          {operation === "retry" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {operation === "retry" ? "Retrying setup..." : "Retry setup"}
        </Button>
      )}
      {confirming ? (
        <div className="mt-2 flex flex-col items-center gap-2">
          <p className="text-xs max-w-xs text-center">
            Skipping may connect the agent before setup finishes. Only use this if setup detection
            appears to be stuck.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={operation !== null}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="text-xs"
              disabled={operation !== null}
              onClick={() => void runOperation("override")}
            >
              {operation === "override" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {operation === "override" ? "Skipping setup..." : "Skip anyway"}
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
          {failed ? "Skip setup" : "Skip setup wait"}
        </Button>
      )}
      {error && (
        <p role="alert" className="max-w-sm text-center text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
