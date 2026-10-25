import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { writeText } from "@/lib/native/clipboard";
import {
  cancelGitHubCliLogin,
  getGitHubCliLogin,
  getGitHubCliStatus,
  openInBrowser,
  setGitHubCliReminderDismissed,
  startGitHubCliLogin,
  type GitHubCliLoginProgress,
  type GitHubCliStatus,
} from "@/lib/backend";
import { cn } from "@/lib/utils";
import { useAccountMachine } from "@/components/settings/account-machine";

const POLL_INTERVAL_MS = 1_500;
const GITHUB_CLI_INSTALL_URL = "https://cli.github.com/";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function CommandLine({ children }: { children: string }) {
  return <pre className="my-1 rounded bg-muted p-2 font-mono text-xs">{children}</pre>;
}

/**
 * Gets the GitHub CLI working: signs it in with GitHub's device flow, or, in
 * the rare case Orkestrator's own copy is unavailable, shows how to install
 * one. Sign-in runs on the backend host, so this also works from a browser
 * client on another machine.
 */
export function GitHubCliSetup({
  onStatusChange,
  className,
  pollIntervalMs = POLL_INTERVAL_MS,
}: {
  onStatusChange?: (status: GitHubCliStatus) => void;
  className?: string;
  pollIntervalMs?: number;
}) {
  const [status, setStatus] = useState<GitHubCliStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [login, setLogin] = useState<GitHubCliLoginProgress>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  // Settings may point this at another machine; the startup reminder never does.
  const { machine } = useAccountMachine();
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const refresh = useCallback(async () => {
    try {
      const next = await getGitHubCliStatus(machine);
      if (!mounted.current) return;
      setStatus(next);
      setError(null);
      onStatusChangeRef.current?.(next);
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, [machine]);

  const checkAgain = () => {
    setChecking(true);
    void refresh();
  };

  useEffect(() => {
    mounted.current = true;
    // refresh updates state only after the asynchronous status request settles.
    // oxlint-disable-next-line react/set-state-in-effect
    void refresh();
    // A sign-in outlives this view: reopening it resumes the one running.
    void getGitHubCliLogin(machine)
      .then((progress) => {
        if (mounted.current && progress.state === "pending") setLogin(progress);
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
    };
  }, [machine, refresh]);

  useEffect(() => {
    if (login.state !== "pending") return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      let pending = true;
      try {
        const next = await getGitHubCliLogin(machine);
        if (cancelled) return;
        pending = next.state === "pending";
        setLogin(next);
        setError(null);
        if (!pending) await refresh();
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause));
      } finally {
        if (!cancelled && pending) timer = window.setTimeout(poll, pollIntervalMs);
      }
    };
    timer = window.setTimeout(poll, pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [login.state, login.operationId, machine, pollIntervalMs, refresh]);

  const run = async (operation: () => Promise<void>) => {
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    }
  };

  const beginLogin = () =>
    run(async () => {
      setCopied(false);
      setLogin(await startGitHubCliLogin(machine));
    });

  const restoreReminder = () =>
    run(async () => {
      await setGitHubCliReminderDismissed(false);
      await refresh();
    });

  const cancelLogin = () =>
    run(async () => {
      setLogin(await cancelGitHubCliLogin(login.operationId, machine));
    });

  const copyCode = (code: string) =>
    run(async () => {
      await writeText(code);
      setCopied(true);
    });

  const signingIn = login.state === "pending";
  const displayedError =
    error ?? (login.state === "failed" ? (login.error ?? "The sign-in failed.") : null);

  let body: ReactNode;
  if (!status) {
    body = (
      <div className="space-y-2">
        {checking ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking the GitHub CLI…
          </p>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={checkAgain}>
            Check again
          </Button>
        )}
      </div>
    );
  } else if (!status.installed) {
    body = (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>The GitHub CLI is not installed. Install it, then check again.</p>
        <p className="font-medium text-foreground">macOS (Homebrew)</p>
        <CommandLine>brew install gh</CommandLine>
        <p className="font-medium text-foreground">Linux</p>
        <CommandLine>
          {"sudo apt install gh  # Debian/Ubuntu\nsudo dnf install gh  # Fedora"}
        </CommandLine>
        <p className="font-medium text-foreground">Windows</p>
        <CommandLine>winget install GitHub.cli</CommandLine>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void openInBrowser(GITHUB_CLI_INSTALL_URL)}
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Install instructions
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={checkAgain} disabled={checking}>
            {checking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Check again
          </Button>
        </div>
      </div>
    );
  } else if (!status.authenticated && !status.canSignIn) {
    body = (
      <p className="text-xs text-muted-foreground">
        The GitHub CLI is not signed in, and this profile cannot sign it in.
      </p>
    );
  } else if (!status.authenticated) {
    body = signingIn ? (
      <div aria-label="GitHub sign-in" className="space-y-2">
        {login.url ? (
          <>
            <p className="text-xs text-muted-foreground">
              Open the page, sign in to GitHub and enter this code:
            </p>
            {login.userCode ? (
              <div className="flex items-center gap-2">
                <code className="rounded bg-zinc-900 px-2 py-1 font-mono text-sm tracking-widest text-foreground">
                  {login.userCode}
                </code>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label="Copy code"
                  onClick={() => void copyCode(login.userCode!)}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void openInBrowser(login.url!)}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open sign-in page
            </Button>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waiting for you to approve the sign-in…
            </p>
          </>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Starting sign-in…
          </p>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={() => void cancelLogin()}>
          Cancel sign-in
        </Button>
      </div>
    ) : (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          The GitHub CLI is installed but not signed in.
        </p>
        <Button type="button" size="sm" onClick={() => void beginLogin()}>
          Sign in to GitHub
        </Button>
      </div>
    );
  } else {
    body = (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-emerald-400" />
        The GitHub CLI is installed and signed in.
      </p>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {body}
      {status?.reminderDismissed && !status.authenticated ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          You won&apos;t be reminded about this at startup.
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => void restoreReminder()}
          >
            Remind me at startup
          </Button>
        </p>
      ) : null}
      {displayedError ? (
        <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{displayedError}</span>
        </p>
      ) : null}
    </div>
  );
}
