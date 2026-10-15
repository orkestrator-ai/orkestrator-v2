import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { writeText } from "@/lib/native/clipboard";
import {
  cancelGitHubCliLogin,
  getGitHubCliInstall,
  getGitHubCliLogin,
  getGitHubCliStatus,
  openInBrowser,
  startGitHubCliInstall,
  startGitHubCliLogin,
  type GitHubCliInstallProgress,
  type GitHubCliLoginProgress,
  type GitHubCliStatus,
} from "@/lib/backend";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 1_500;
const GITHUB_CLI_INSTALL_URL = "https://cli.github.com/";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function CommandLine({ children }: { children: string }) {
  return <pre className="my-1 rounded bg-muted p-2 font-mono text-xs">{children}</pre>;
}

/**
 * Gets the host's GitHub CLI working: installs it with Homebrew where that is
 * possible, otherwise shows how to install it, then signs it in with GitHub's
 * device flow. Both run on the backend host, so this also works from a browser
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
  const [checking, setChecking] = useState(false);
  const [install, setInstall] = useState<GitHubCliInstallProgress>({ state: "idle" });
  const [login, setLogin] = useState<GitHubCliLoginProgress>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const next = await getGitHubCliStatus();
      if (!mounted.current) return;
      setStatus(next);
      onStatusChangeRef.current?.(next);
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // An install or sign-in outlives this view: reopening it resumes the one running.
    void getGitHubCliInstall()
      .then((progress) => {
        if (mounted.current && progress.state === "pending") setInstall(progress);
      })
      .catch(() => undefined);
    void getGitHubCliLogin()
      .then((progress) => {
        if (mounted.current && progress.state === "pending") setLogin(progress);
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (install.state !== "pending") return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await getGitHubCliInstall();
        if (!mounted.current) return;
        setInstall(next);
        if (next.state === "failed") setError(next.error ?? "The install failed.");
        if (next.state !== "pending") await refresh();
      } catch (cause) {
        if (mounted.current) setError(messageOf(cause));
      }
    }, pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [install, pollIntervalMs, refresh]);

  useEffect(() => {
    if (login.state !== "pending") return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await getGitHubCliLogin();
        if (!mounted.current) return;
        setLogin(next);
        if (next.state === "failed") setError(next.error ?? "The sign-in failed.");
        if (next.state !== "pending") await refresh();
      } catch (cause) {
        if (mounted.current) setError(messageOf(cause));
      }
    }, pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [login, pollIntervalMs, refresh]);

  const run = async (operation: () => Promise<void>) => {
    setError(null);
    try {
      await operation();
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    }
  };

  const beginInstall = () =>
    run(async () => {
      const next = await startGitHubCliInstall();
      if (!mounted.current) return;
      setInstall(next);
      if (next.state !== "pending") await refresh();
    });

  const beginLogin = () =>
    run(async () => {
      setCopied(false);
      setLogin(await startGitHubCliLogin());
    });

  const cancelLogin = () =>
    run(async () => {
      setLogin(await cancelGitHubCliLogin(login.operationId));
    });

  const copyCode = (code: string) =>
    run(async () => {
      await writeText(code);
      setCopied(true);
    });

  const installing = install.state === "pending";
  const signingIn = login.state === "pending";

  let body: ReactNode;
  if (!status) {
    body = (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking the GitHub CLI…
      </p>
    );
  } else if (!status.installed) {
    body = status.canInstallWithHomebrew ? (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          The GitHub CLI is not installed. Orkestrator can install it with Homebrew.
        </p>
        <Button type="button" size="sm" onClick={() => void beginInstall()} disabled={installing}>
          {installing ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Installing GitHub CLI…
            </>
          ) : (
            "Install with Homebrew"
          )}
        </Button>
      </div>
    ) : (
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
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={checking}
          >
            {checking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Check again
          </Button>
        </div>
      </div>
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
      {error ? (
        <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{error}</span>
        </p>
      ) : null}
    </div>
  );
}
