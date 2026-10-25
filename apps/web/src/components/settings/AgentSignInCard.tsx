/**
 * One platform's sign-in state at the top of its settings page, read without a
 * session (`get_agent_sign_in_status`).
 *
 * The state is the same `NativeAgentAuthStatus` a tab's Agent Info card shows,
 * but read on the host, so it is there before any environment runs the
 * platform. Each platform keeps its own sign-in surface underneath:
 *
 * - Claude: the active account is signed in again in place, through the same
 *   backend `claude auth login` as the tab's sign-in card.
 * - Codex: the accounts list below adds and switches logins; this card only
 *   says whether the active one is signed in.
 * - Cursor: the card wraps `CursorSdkSignIn`, passed as children.
 * - OpenCode: provider logins are listed under Provider Sign-in below.
 * - Grok and Pi: the terminal command is named; their logins are interactive
 *   CLI flows Orkestrator does not drive.
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, CircleHelp, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClaudeAccountSignInAction } from "@/components/claude/ClaudeAccountSignInAction";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import { getAgentSignInStatus } from "@/lib/backend";
import { useAccountMachine } from "./account-machine";
import { cn } from "@/lib/utils";
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  NativeAgentAuthState,
  NativeAgentAuthStatus,
} from "@orkestrator/protocol/native-agent";

const STATE_LABELS: Record<NativeAgentAuthState, string> = {
  "signed-in": "Signed in",
  "signed-out": "Signed out",
  "needs-auth": "Needs sign-in",
  expired: "Login expired",
  unknown: "Not confirmed",
};

/** The command a terminal runs to sign the platform in, fixed here as in the tab. */
const TERMINAL_COMMANDS: Partial<Record<AgentPlatform, string>> = {
  grok: "grok login",
  pi: "pi",
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function StateBadge({ state }: { state: NativeAgentAuthState }) {
  const signedIn = state === "signed-in";
  const unknown = state === "unknown";
  const Icon = signedIn ? CheckCircle2 : unknown ? CircleHelp : AlertCircle;
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
        signedIn
          ? "bg-emerald-500/10 text-emerald-500"
          : unknown
            ? "bg-zinc-500/10 text-muted-foreground"
            : "bg-amber-500/10 text-amber-500",
      )}
    >
      <Icon aria-hidden="true" className="h-3 w-3" />
      {STATE_LABELS[state]}
    </span>
  );
}

export function AgentSignInCard({
  platform,
  reloadToken = 0,
  children,
}: {
  platform: AgentPlatform;
  /** Bumped by the page when a credential may have changed. */
  reloadToken?: number | string;
  /** The platform's own sign-in controls (Cursor's), shown inside the card. */
  children?: ReactNode;
}) {
  const { machine } = useAccountMachine();
  const label = AGENT_PLATFORM_LABELS[platform];
  const signIn = useCoordinatedRead<NativeAgentAuthStatus>({
    key: { resource: "agent-sign-in-status", target: machine ?? "backend", options: platform },
    read: () => getAgentSignInStatus(platform, machine),
    trackState: true,
  });
  const { refresh } = signIn;
  const status = signIn.state?.hasValue ? (signIn.state.value ?? null) : null;
  const error = signIn.state?.status === "error" ? messageOf(signIn.state.error) : null;
  const loading = !signIn.state || signIn.state.status === "loading";
  const reload = useCallback(() => void refresh(), [refresh]);

  // A credential change elsewhere on the page (a Cursor sign-in, a saved key)
  // asks for a fresh read; the first token is the mount read itself.
  const seenReloadToken = useRef(reloadToken);
  useEffect(() => {
    if (seenReloadToken.current === reloadToken) return;
    seenReloadToken.current = reloadToken;
    void refresh();
  }, [refresh, reloadToken]);

  const signedIn = status?.state === "signed-in";
  const command = TERMINAL_COMMANDS[platform];

  return (
    <section
      aria-label={`${label} sign-in`}
      className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            <KeyRound aria-hidden="true" className="h-4 w-4" />
            Sign-in
            {status ? <StateBadge state={status.state} /> : null}
          </h3>
          {status?.account ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {status.account.label}
              {status.account.plan ? ` · ${status.account.plan}` : ""}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          aria-label={`Refresh ${label} sign-in`}
          disabled={loading}
          onClick={reload}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mt-3 flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {status?.providers?.length ? (
        <ul aria-label={`${label} signed-in providers`} className="mt-3 flex flex-wrap gap-1.5">
          {status.providers.map((provider) => (
            <li
              key={provider.id}
              className="rounded border border-zinc-800 bg-zinc-900/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {provider.label}
              {provider.method ? ` · ${provider.method}` : ""}
            </li>
          ))}
        </ul>
      ) : null}

      {platform === "claude" && status && !signedIn ? (
        <div className="mt-3">
          <ClaudeAccountSignInAction onSignedIn={reload} />
        </div>
      ) : null}

      {status && !signedIn && status.signIn?.hint && platform !== "cursor" ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {status.signIn.hint}
          {command ? (
            <>
              {" "}
              Command:{" "}
              <code className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-zinc-300">
                {command}
              </code>
            </>
          ) : null}
        </p>
      ) : null}

      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}
