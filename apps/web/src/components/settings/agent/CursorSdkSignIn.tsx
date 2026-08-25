/**
 * Sign-in for the experimental Cursor SDK bridge.
 *
 * Deliberately thin. The backend spawns the bridge's login mode, which opens
 * the browser, parses its output, stores the credential and owns the
 * one-at-a-time rule; this view starts that flow and reflects the status it is
 * told. It makes no decision of its own about credentials, and it cannot open
 * the browser itself — the desktop window denies `window.open` and
 * `target="_blank"`, so its only fallback is to hand the user the URL.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { writeText } from "@/lib/native/clipboard";
import {
  cursorSdkLoginCancel,
  cursorSdkLoginStart,
  cursorSdkLoginStatus,
  cursorSdkLogout,
} from "@/lib/backend";
import type { CursorSdkLoginProgress } from "@/types";

/** How often to ask the backend whether the browser flow has finished. */
const POLL_INTERVAL_MS = 1_500;

interface CursorSdkSignInProps {
  /** Changes after a stored API key is saved or cleared. */
  credentialRevision: string;
}

export function CursorSdkSignIn({ credentialRevision }: CursorSdkSignInProps) {
  const [progress, setProgress] = useState<CursorSdkLoginProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Guards every setState against a poll that resolves after unmount, which is
  // ordinary here: the settings dialog closes while a login is still pending.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await cursorSdkLoginStatus();
      if (mounted.current) {
        setProgress(next);
        setError(null);
      }
      return next;
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [credentialRevision, refresh]);

  // Polls only while a login is actually in flight, so an idle settings pane
  // costs nothing.
  useEffect(() => {
    if (progress?.state !== "pending") return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [progress?.state, refresh]);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      // The backend's login child opens the browser on the user's machine.
      // This view deliberately does not: the desktop window denies both
      // `window.open` and `target="_blank"`, so anything it tried would
      // silently do nothing.
      await cursorSdkLoginStart();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const copyLoginUrl = async () => {
    const loginUrl = progress?.loginUrl;
    if (!loginUrl) return;
    try {
      await writeText(loginUrl);
      if (mounted.current) setCopied(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await cursorSdkLogout();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const cancel = async () => {
    await cursorSdkLoginCancel().catch(() => undefined);
    await refresh();
  };

  const auth = progress?.auth;
  const pending = progress?.state === "pending";

  return (
    <div className="space-y-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <LogIn className="h-4 w-4" />
          Cursor sign-in
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          The SDK bridge signs in through your browser and stores a Cursor API key that Orkestrator
          owns. A Cursor API key above, if set, is used instead.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {auth?.authenticated ? (
          <span className="flex items-center gap-1.5 text-xs text-emerald-500">
            <Check className="h-3.5 w-3.5" />
            {describeSource(auth)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Not signed in</span>
        )}
      </div>

      {auth?.expiresAt && (
        <p className="text-xs text-muted-foreground">
          Key expires {new Date(auth.expiresAt).toLocaleDateString()}.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={signIn}
          disabled={busy || pending}
        >
          {busy || pending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <LogIn className="mr-1.5 h-3.5 w-3.5" />
          )}
          {auth?.source === "stored-login" ? "Sign in again" : "Sign in with Cursor"}
        </Button>
        {auth?.source === "stored-login" && (
          <Button type="button" variant="ghost" size="sm" onClick={signOut} disabled={busy}>
            <LogOut className="mr-1.5 h-3.5 w-3.5" />
            Sign out
          </Button>
        )}
      </div>

      {pending && progress?.loginUrl && (
        <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            Waiting for you to finish signing in. If the browser did not open, copy this link:
          </p>
          {/*
            Selectable text plus a copy button rather than a link. The desktop
            window denies `window.open` and `target="_blank"` outright, so an
            anchor here would look clickable and do nothing.
          */}
          <p className="select-all break-all font-mono text-xs text-muted-foreground">
            {progress.loginUrl}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={copyLoginUrl}>
              {copied ? (
                <Check className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Copy className="mr-1.5 h-3.5 w-3.5" />
              )}
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {progress?.state === "failed" && progress.error && (
        <p className="text-xs text-amber-500">{progress.error}</p>
      )}
      {error && <p className="text-xs text-amber-500">{error}</p>}

      <p className="text-xs text-muted-foreground">
        Signing out forgets the key here only. It stays valid until it expires unless you revoke it
        from Cursor&apos;s dashboard.
      </p>
    </div>
  );
}

function describeSource(auth: NonNullable<CursorSdkLoginProgress["auth"]>): string {
  switch (auth.source) {
    case "stored-login":
      return auth.email ? `Signed in as ${auth.email}` : "Signed in";
    case "api-key-config":
      return "Using the stored Cursor API key";
    case "api-key-env":
      return "Using CURSOR_API_KEY from the environment";
    default:
      return "Signed in";
  }
}
