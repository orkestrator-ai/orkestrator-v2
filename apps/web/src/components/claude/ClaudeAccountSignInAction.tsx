import { useEffect, useRef, useState } from "react";
import { Check, Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAccountLoginPanel } from "@/components/settings/AgentAccountLoginPanel";
import { useAgentAccountReauth } from "@/hooks/useAgentAccountReauth";
import { useConfigStore } from "@/stores/configStore";

/**
 * The compact form of `ClaudeAuthRecoveryCard`'s sign-in, for places that
 * show Claude's account state rather than a failed turn: the Agent Info
 * account card and the settings sign-in card.
 *
 * It renews the login Claude actually runs on, the host login or the active
 * added account, through the backend's `claude auth login`. A container with
 * its own isolated login is signed in from a terminal inside it, so this
 * renders nothing there and the caller's hint stands.
 */
export function ClaudeAccountSignInAction({
  containerId,
  onSignedIn,
}: {
  containerId?: string;
  /** Lets the caller re-read the account state once a sign-in here finishes. */
  onSignedIn?: () => void;
}) {
  const useHostClaudeCredentials = useConfigStore(
    (state) => state.config.global.useHostClaudeCredentials ?? true,
  );
  const isolatedContainer = Boolean(containerId) && !useHostClaudeCredentials;
  const reauth = useAgentAccountReauth("claude", !isolatedContainer);
  // The backend keeps the last sign-in's result for every card to recover. One
  // that finished before this action appeared says nothing about the login the
  // caller just reported as missing, so only a newer success counts.
  const [shownAt] = useState(() => Date.now());
  const completedAt = reauth.progress.completedAt ? Date.parse(reauth.progress.completedAt) : NaN;
  const signedInHere = reauth.progress.state === "succeeded" && completedAt >= shownAt;
  // Once per finished sign-in, whatever identity the caller's callback has.
  const onSignedInRef = useRef(onSignedIn);
  useEffect(() => {
    onSignedInRef.current = onSignedIn;
  }, [onSignedIn]);
  const notifiedOperation = useRef<string | undefined>(undefined);
  const operationId = reauth.progress.operationId;
  useEffect(() => {
    if (!signedInHere || notifiedOperation.current === operationId) return;
    notifiedOperation.current = operationId;
    onSignedInRef.current?.();
  }, [signedInHere, operationId]);
  if (isolatedContainer) return null;

  if (signedInHere) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-emerald-400">
        <Check aria-hidden="true" className="size-3.5" />
        Signed in to Claude.
      </p>
    );
  }
  if (reauth.progress.state === "pending") {
    return (
      <AgentAccountLoginPanel
        progress={reauth.progress}
        onCancel={() => void reauth.cancel()}
        onError={reauth.reportError}
      />
    );
  }
  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        size="sm"
        className="h-7 gap-1.5"
        disabled={reauth.starting}
        onClick={() => void reauth.start()}
      >
        {reauth.starting ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <LogIn aria-hidden="true" className="size-3.5" />
        )}
        Sign in to Claude
      </Button>
      {reauth.error ? (
        <p role="alert" className="text-xs text-destructive">
          {reauth.error}
        </p>
      ) : null}
    </div>
  );
}
