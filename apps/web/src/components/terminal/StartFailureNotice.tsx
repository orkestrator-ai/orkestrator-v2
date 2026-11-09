import { useState } from "react";
import { AlertCircle, Globe, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import type { EnvironmentLifecycleRemedy } from "@orkestrator/protocol/contract/domains/environments";

interface StartFailureNoticeProps {
  /** The backend's sanitized failure (`lifecycleError`); safe to render. */
  message: string;
  /** A fix the backend checked would work (`lifecycleRemedy`). */
  remedy: EnvironmentLifecycleRemedy | null;
  projectId: string | null;
  /** Starts the environment again once the remedy is applied. */
  onRetry?: () => void;
}

/**
 * Why the last start failed, kept on the environment rather than only in a
 * toast, and the one-click fix when the backend found one. The message is
 * rehydrated from the environment record, so it survives switching away,
 * reloads and restarts until the next start clears it.
 */
export function StartFailureNotice({
  message,
  remedy,
  projectId,
  onRetry,
}: StartFailureNoticeProps) {
  const backend = useScopeBackend();
  const [switching, setSwitching] = useState(false);
  const offerHttps = remedy === "use-https" && projectId !== null && onRetry !== undefined;

  const switchToHttps = async () => {
    if (!projectId || switching) return;
    setSwitching(true);
    try {
      const { remoteUrl } = await backend.switchProjectRemoteToHttps(projectId);
      toast.success("Project now uses HTTPS", { description: `origin is ${remoteUrl}` });
      onRetry?.();
    } catch (error) {
      toast.error("Couldn't switch the project to HTTPS", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div
      role="alert"
      className="mx-auto mb-4 w-full max-w-md rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-left"
    >
      <div className="flex gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <p className="text-sm text-foreground">{message}</p>
      </div>
      {offerHttps && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => void switchToHttps()} disabled={switching}>
            {switching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Globe className="mr-2 h-4 w-4" aria-hidden />
            )}
            Use HTTPS for this project
          </Button>
        </div>
      )}
    </div>
  );
}
