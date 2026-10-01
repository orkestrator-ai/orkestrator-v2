import { useId } from "react";
import { Check, KeyRound, Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAccountLoginPanel } from "@/components/settings/AgentAccountLoginPanel";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { useAgentAccountReauth } from "@/hooks/useAgentAccountReauth";
import { useConfigStore } from "@/stores/configStore";
import { CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND, CLAUDE_AUTH_LOGIN_COMMAND } from "@/lib/claude-auth";

interface ClaudeAuthRecoveryCardProps {
  error: string;
  failureAt?: string;
  containerId?: string;
  /** `pinned` sits above the composer, outside the transcript's own padding. */
  placement?: "transcript" | "pinned";
}

/**
 * Turns a Claude credential failure into a recovery step.
 *
 * The sign-in runs in the app: the backend drives `claude auth login`, the card
 * shows the link and takes the code. It renews the login the agent actually
 * uses (the host login or the active added account), and a container that
 * shares it picks the new login up the next time its idle bridge starts. Only
 * a container with its own isolated login still needs a terminal, because that
 * login lives inside the container.
 */
export function ClaudeAuthRecoveryCard({
  error,
  failureAt,
  containerId,
  placement = "transcript",
}: ClaudeAuthRecoveryCardProps) {
  const headingId = useId();
  const createTab = useOptionalTerminalContext()?.createTab;
  const useHostClaudeCredentials = useConfigStore(
    (state) => state.config.global.useHostClaudeCredentials ?? true,
  );
  const isolatedContainer = Boolean(containerId) && !useHostClaudeCredentials;
  const reauth = useAgentAccountReauth("claude", !isolatedContainer, failureAt);
  const canOpenTerminal = Boolean(createTab) && (isolatedContainer || !containerId);
  const signedIn = reauth.progress.state === "succeeded";
  const signingIn = reauth.progress.state === "pending";

  const openSignInTerminal = () => {
    createTab?.("plain", {
      displayTitle: "Claude sign-in",
      initialCommands: [
        isolatedContainer ? CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND : CLAUDE_AUTH_LOGIN_COMMAND,
      ],
    });
  };

  const card = (
    <div
      role="region"
      aria-labelledby={headingId}
      className="rounded-xl border border-amber-400/25 bg-amber-400/[0.055] px-4 py-3.5"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg border border-amber-300/20 bg-amber-300/10 p-2 text-amber-200">
          <KeyRound aria-hidden="true" className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p id={headingId} className="text-sm font-medium text-foreground">
            Sign in to Claude
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Claude needs you to sign in again. After signing in, return here and resend your
            message.
          </p>

          {signedIn ? (
            <p role="status" className="mt-3 flex items-center gap-2 text-xs text-emerald-400">
              <Check aria-hidden="true" className="size-3.5" />
              Signed in. Resend your message to continue.
            </p>
          ) : signingIn ? (
            <div className="mt-3">
              <AgentAccountLoginPanel
                progress={reauth.progress}
                onCancel={() => void reauth.cancel()}
                onError={reauth.reportError}
              />
            </div>
          ) : isolatedContainer ? (
            <p className="mt-2 text-xs text-muted-foreground">
              This container keeps its own Claude login, so it is signed in from a terminal inside
              it.
            </p>
          ) : null}

          {!signedIn && !signingIn ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {isolatedContainer ? (
                canOpenTerminal ? (
                  <Button type="button" size="sm" className="gap-2" onClick={openSignInTerminal}>
                    <LogIn aria-hidden="true" className="size-4" />
                    Sign in to Claude
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Open a terminal and run{" "}
                    <code className="rounded bg-background/70 px-1.5 py-0.5 text-foreground">
                      {CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND}
                    </code>
                    .
                  </p>
                )
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    className="gap-2"
                    disabled={reauth.starting}
                    onClick={() => void reauth.start()}
                  >
                    {reauth.starting ? (
                      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                    ) : (
                      <LogIn aria-hidden="true" className="size-4" />
                    )}
                    Sign in to Claude
                  </Button>
                  {canOpenTerminal ? (
                    <Button type="button" size="sm" variant="ghost" onClick={openSignInTerminal}>
                      Use a terminal instead
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {reauth.error ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {reauth.error}
            </p>
          ) : null}

          <details className="mt-3 text-[11px] text-muted-foreground/70">
            <summary className="w-fit cursor-pointer select-none hover:text-muted-foreground">
              Error details
            </summary>
            <p className="mt-1.5 whitespace-pre-wrap break-words">{error}</p>
          </details>
        </div>
      </div>
    </div>
  );

  if (placement === "pinned") return card;
  return (
    <div className="px-3 py-3 @sm:px-6">
      <div className="mx-auto max-w-3xl min-w-0">{card}</div>
    </div>
  );
}
