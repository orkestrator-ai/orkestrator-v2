import { useId } from "react";
import { KeyRound, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { useConfigStore } from "@/stores/configStore";
import { CLAUDE_AUTH_LOGIN_COMMAND, CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND } from "@/lib/claude-auth";

interface ClaudeAuthRecoveryCardProps {
  error: string;
  containerId?: string;
}

/**
 * Turns a provider-confirmed Claude credential failure into a recovery step.
 * Shared Docker credentials must be repaired on the host; isolated container
 * credentials and local environments can use the current environment terminal.
 */
export function ClaudeAuthRecoveryCard({ error, containerId }: ClaudeAuthRecoveryCardProps) {
  const headingId = useId();
  const createTab = useOptionalTerminalContext()?.createTab;
  const useHostClaudeCredentials = useConfigStore(
    (state) => state.config.global.useHostClaudeCredentials ?? true,
  );
  const needsExternalHostLogin = Boolean(containerId) && useHostClaudeCredentials;
  const loginCommand =
    containerId && !useHostClaudeCredentials
      ? CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND
      : CLAUDE_AUTH_LOGIN_COMMAND;
  const canOpenLoginTerminal = Boolean(createTab) && !needsExternalHostLogin;

  const openSignInTerminal = () => {
    if (!createTab || needsExternalHostLogin) return;
    createTab("plain", {
      displayTitle: "Claude sign-in",
      initialCommands: [loginCommand],
    });
  };

  return (
    <div className="px-3 py-3 @sm:px-6">
      <div className="mx-auto max-w-3xl min-w-0">
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
              {needsExternalHostLogin ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  This container uses your host Claude login. Open a terminal on the host and run{" "}
                  <code className="rounded bg-background/70 px-1.5 py-0.5 text-foreground">
                    {CLAUDE_AUTH_LOGIN_COMMAND}
                  </code>
                  . Then restart this environment to copy the refreshed credential into it.
                </p>
              ) : !canOpenLoginTerminal ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Open a terminal and run{" "}
                  <code className="rounded bg-background/70 px-1.5 py-0.5 text-foreground">
                    {loginCommand}
                  </code>
                  .
                </p>
              ) : null}
              {canOpenLoginTerminal ? (
                <Button type="button" size="sm" className="mt-3 gap-2" onClick={openSignInTerminal}>
                  <LogIn aria-hidden="true" className="size-4" />
                  Sign in to Claude
                </Button>
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
      </div>
    </div>
  );
}
