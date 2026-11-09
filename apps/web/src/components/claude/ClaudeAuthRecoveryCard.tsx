import { useId, useState } from "react";
import { Check, KeyRound, Loader2, LogIn, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAccountLoginPanel } from "@/components/settings/AgentAccountLoginPanel";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { useAgentAccountReauth } from "@/hooks/useAgentAccountReauth";
import { agentAccountDisplayName, useActiveAgentAccount } from "@/hooks/useActiveAgentAccount";
import { useSessionMachineName } from "@/components/layout/AgentInfoAccountSection";
import { useConfigStore } from "@/stores/configStore";
import { CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND, CLAUDE_AUTH_LOGIN_COMMAND } from "@/lib/claude-auth";

interface ClaudeAuthRecoveryCardProps {
  error: string;
  failureAt?: string;
  containerId?: string;
  /**
   * `transcript` pads itself like a transcript row. `pinned` brings no padding
   * of its own, for a slot that already has it: above the composer, or among
   * the cards at the end of the transcript.
   */
  placement?: "transcript" | "pinned";
  /**
   * The backend holds the refused message and sends it again when this
   * machine's login is renewed, whichever client renews it. Without it the card
   * asks the user to resend it.
   */
  resendsAfterSignIn?: boolean;
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
  resendsAfterSignIn = false,
}: ClaudeAuthRecoveryCardProps) {
  const headingId = useId();
  const createTab = useOptionalTerminalContext()?.createTab;
  const useHostClaudeCredentials = useConfigStore(
    (state) => state.config.global.useHostClaudeCredentials ?? true,
  );
  const isolatedContainer = Boolean(containerId) && !useHostClaudeCredentials;
  const reauth = useAgentAccountReauth("claude", !isolatedContainer, failureAt);
  const canOpenTerminal = Boolean(createTab) && (isolatedContainer || !containerId);
  const [terminalSignIn, setTerminalSignIn] = useState(false);
  // A terminal sign-in runs outside the backend's own, which is what triggers
  // the resend, so that path still asks the user to send it again.
  const automaticResend = !isolatedContainer && !terminalSignIn && resendsAfterSignIn;
  const signedIn = !isolatedContainer && reauth.progress.state === "succeeded";
  const signingIn = reauth.progress.state === "pending";
  // The login being renewed is this machine's; with several machines, say which.
  const machineName = useSessionMachineName();
  // The sign-in renews the machine's active account, so the card names it. A
  // container with its own login is not one of the machine's accounts.
  const activeAccount = useActiveAgentAccount("claude", !isolatedContainer);
  const accountName = activeAccount ? agentAccountDisplayName(activeAccount) : "";

  const openSignInTerminal = () => {
    setTerminalSignIn(true);
    createTab?.("plain", {
      displayTitle: "Claude sign-in",
      initialCommands: [
        isolatedContainer ? CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND : CLAUDE_AUTH_LOGIN_COMMAND,
      ],
    });
  };

  const actions =
    signedIn || signingIn ? null : isolatedContainer ? (
      canOpenTerminal ? (
        <Button type="button" size="sm" className="gap-2" onClick={openSignInTerminal}>
          <LogIn aria-hidden="true" className="size-4" />
          Sign in to Claude
        </Button>
      ) : null
    ) : (
      <>
        {canOpenTerminal ? (
          <Button type="button" size="sm" variant="ghost" onClick={openSignInTerminal}>
            Use a terminal instead
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          className="gap-2"
          disabled={reauth.starting}
          onClick={() => {
            setTerminalSignIn(false);
            void reauth.start();
          }}
        >
          {reauth.starting ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <LogIn aria-hidden="true" className="size-4" />
          )}
          Sign in to Claude
        </Button>
      </>
    );

  // The same surface as the question and approval cards beside it: a neutral
  // panel with a header strip, a body, and a footer strip for the actions.
  const card = (
    <div
      role="region"
      aria-labelledby={headingId}
      className="overflow-hidden rounded-lg border border-border/70 bg-zinc-900/90 shadow-sm shadow-black/15"
    >
      <div className="flex items-center gap-2 border-b border-border/60 bg-white/[0.02] px-3 py-2">
        <KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span id={headingId} className="min-w-0 truncate text-xs font-medium text-foreground">
          {machineName ? `Sign in to Claude on ${machineName}` : "Sign in to Claude"}
        </span>
      </div>

      <div className="px-3 py-3">
        {accountName ? (
          <p
            data-testid="claude-sign-in-account"
            className="flex min-w-0 items-center gap-1.5 text-sm"
          >
            <UserRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">Account</span>
            <span className="truncate font-medium text-foreground" title={accountName}>
              {accountName}
            </span>
          </p>
        ) : null}
        <p
          className={
            accountName
              ? "mt-1.5 text-xs leading-relaxed text-muted-foreground"
              : "text-sm leading-relaxed text-foreground"
          }
        >
          {machineName
            ? `Each machine keeps its own Claude login, and ${machineName}'s needs signing in again.`
            : "Claude needs you to sign in again."}{" "}
          {automaticResend
            ? "Your message is sent again once you sign in."
            : "After signing in, return here and resend your message."}
        </p>

        {signedIn ? (
          <p role="status" className="mt-3 flex items-center gap-2 text-xs text-emerald-400">
            <Check aria-hidden="true" className="size-3.5" />
            {automaticResend
              ? "Signed in. Sending your message again…"
              : "Signed in. Resend your message to continue."}
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
            This container keeps its own Claude login, so it is signed in from a terminal inside it.
            {canOpenTerminal ? null : (
              <>
                {" "}
                Open a terminal and run{" "}
                <code className="rounded bg-background/70 px-1.5 py-0.5 text-foreground">
                  {CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND}
                </code>
                .
              </>
            )}
          </p>
        ) : null}

        {reauth.error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {reauth.error}
          </p>
        ) : null}

        <details className="mt-3 text-[11px] text-muted-foreground/70">
          <summary className="w-fit cursor-pointer select-none hover:text-muted-foreground">
            Claude&apos;s error
          </summary>
          <p className="mt-1.5 whitespace-pre-wrap break-words">{error}</p>
        </details>
      </div>

      {actions ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 bg-white/[0.02] px-3 py-2.5">
          {actions}
        </div>
      ) : null}
    </div>
  );

  if (placement === "pinned") return card;
  return (
    <div className="px-3 py-3 @sm:px-6">
      <div className="mx-auto max-w-3xl min-w-0">{card}</div>
    </div>
  );
}
