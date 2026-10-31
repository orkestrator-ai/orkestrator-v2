/**
 * OpenCode's model provider logins, in the OpenCode settings pane.
 *
 * OpenCode keeps one login per provider in the host's own store, which every
 * local environment shares, so there are no accounts to switch: a provider is
 * signed in, its key replaced, or signed out. Reading the list starts a
 * private OpenCode server, so it is read when the pane opens and after each
 * change, never polled.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Loader2, LogOut, PlugZap, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOpenCodeProviderLogin } from "@/hooks/useOpenCodeProviderLogin";
import { OpenCodeProviderSignIn } from "@/components/opencode/OpenCodeProviderSignIn";
import { listOpenCodeProviderAuth, removeOpenCodeProviderLogin } from "@/lib/backend";
import { useAccountMachine } from "@/components/settings/account-machine";
import type {
  OpenCodeProviderAuthEntry,
  OpenCodeProviderAuthSnapshot,
} from "@orkestrator/protocol/opencode-provider-auth";
import { SettingsSectionHeader } from "./SettingsPageLayout";

const MAX_SEARCH_RESULTS = 12;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function describeState(provider: OpenCodeProviderAuthEntry): string {
  if (!provider.connected) return "Not signed in";
  if (!provider.storedLogin) return "Connected by environment or configuration";
  return "Signed in";
}

function ProviderRow({
  provider,
  expanded,
  busy,
  onToggle,
  onSignedIn,
  onSignOut,
}: {
  provider: OpenCodeProviderAuthEntry;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onSignedIn: () => void;
  onSignOut: () => void;
}) {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  return (
    <li
      aria-label={provider.label}
      className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            {provider.label}
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {provider.id}
            </span>
          </p>
          <p
            className={`mt-0.5 flex items-center gap-1.5 text-xs ${
              provider.connected ? "text-emerald-400" : "text-muted-foreground"
            }`}
          >
            {provider.connected ? <Check className="h-3 w-3" /> : null}
            {describeState(provider)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {confirmingSignOut ? (
            <>
              <span className="text-xs text-muted-foreground">
                {provider.canRemoveStoredLogin ? "Remove any stored login?" : "Remove this login?"}
              </span>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setConfirmingSignOut(false);
                  onSignOut();
                }}
              >
                {provider.canRemoveStoredLogin ? "Remove stored login" : "Sign out"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmingSignOut(false)}
              >
                Keep
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant={provider.connected ? "outline" : "default"}
                disabled={busy}
                aria-expanded={expanded}
                onClick={onToggle}
              >
                {provider.connected ? "Sign in again" : "Sign in"}
              </Button>
              {provider.storedLogin || provider.canRemoveStoredLogin ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  aria-label={
                    provider.canRemoveStoredLogin
                      ? `Remove stored login for ${provider.label}`
                      : `Sign out of ${provider.label}`
                  }
                  disabled={busy}
                  onClick={() => setConfirmingSignOut(true)}
                >
                  <LogOut className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
      {expanded ? (
        <OpenCodeProviderSignIn provider={provider} onSignedIn={onSignedIn} onCancel={onToggle} />
      ) : null}
    </li>
  );
}

export function OpenCodeProvidersSection() {
  const [snapshot, setSnapshot] = useState<OpenCodeProviderAuthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const { machine } = useAccountMachine();

  // State changes only once the read settles, so the mount effect never sets
  // state synchronously; `load` marks a refresh first.
  const read = useCallback(
    () =>
      listOpenCodeProviderAuth(machine).then(
        (providers) => {
          setSnapshot(providers);
          setError(null);
          setLoading(false);
        },
        (cause: unknown) => {
          setError(messageOf(cause));
          setLoading(false);
        },
      ),
    [machine],
  );
  const load = useCallback(async () => {
    setLoading(true);
    await read();
  }, [read]);

  useEffect(() => {
    void read();
  }, [read]);

  const login = useOpenCodeProviderLogin(undefined, () => void load());
  const pendingProviderId =
    login.progress.state === "pending" ? login.progress.providerId : undefined;

  const listed = useMemo(
    () =>
      (snapshot?.providers ?? []).filter(
        (provider) =>
          provider.connected ||
          provider.allowed ||
          provider.id === expanded ||
          provider.id === pendingProviderId,
      ),
    [snapshot, expanded, pendingProviderId],
  );
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const shown = new Set(listed.map((provider) => provider.id));
    return (snapshot?.providers ?? [])
      .filter(
        (provider) =>
          !shown.has(provider.id) &&
          (provider.id.toLowerCase().includes(needle) ||
            provider.label.toLowerCase().includes(needle)),
      )
      .slice(0, MAX_SEARCH_RESULTS);
  }, [snapshot, listed, query]);

  const signedIn = (provider: OpenCodeProviderAuthEntry) => {
    setExpanded(null);
    setQuery("");
    setNotice(
      `Signed in to ${provider.label}. Idle OpenCode agents pick the new login up on their next message.`,
    );
    void load();
  };

  const signOut = async (provider: OpenCodeProviderAuthEntry) => {
    setBusy(true);
    setNotice(null);
    try {
      await removeOpenCodeProviderLogin(provider.id, machine);
      setNotice(
        provider.canRemoveStoredLogin
          ? `Removed any stored login for ${provider.label}. Environment or configuration credentials may keep it connected.`
          : `Signed out of ${provider.label}.`,
      );
      await load();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (provider: OpenCodeProviderAuthEntry) => {
    setNotice(null);
    setExpanded((current) => (current === provider.id ? null : provider.id));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <SettingsSectionHeader icon={<PlugZap className="h-4 w-4" />} title="Provider Sign-in">
          The model providers OpenCode is signed in to, shared by every local environment. OpenCode
          cannot tell an expired key from a valid one: if a model request fails with HTTP 401, sign
          in again here. Containers copy the login in when they start.
        </SettingsSectionHeader>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          aria-label="Refresh provider sign-in"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {pendingProviderId ? (
        <div
          role="status"
          className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs"
        >
          <p>Sign-in to {login.progress.providerLabel ?? pendingProviderId} is in progress.</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => void login.cancel()}>
            Cancel sign-in to {login.progress.providerLabel ?? pendingProviderId}
          </Button>
        </div>
      ) : null}
      {login.error ? <p className="text-xs text-destructive">{login.error}</p> : null}
      {notice ? (
        <p role="status" className="flex items-center gap-2 text-xs text-emerald-400">
          <Check className="h-3.5 w-3.5" />
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {!snapshot && loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking OpenCode providers…
        </p>
      ) : null}

      {snapshot ? (
        <>
          {listed.length > 0 ? (
            <ul className="space-y-2">
              {listed.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  expanded={expanded === provider.id || pendingProviderId === provider.id}
                  busy={busy || Boolean(pendingProviderId)}
                  onToggle={() => toggle(provider)}
                  onSignedIn={() => signedIn(provider)}
                  onSignOut={() => void signOut(provider)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No provider is signed in yet.</p>
          )}

          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Find a provider to sign in to"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Sign in to another provider, e.g. anthropic"
                className="h-8 pl-8 text-xs"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            {matches.length > 0 ? (
              <ul aria-label="Matching providers" className="space-y-1">
                {matches.map((provider) => (
                  <li key={provider.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50"
                      disabled={Boolean(pendingProviderId)}
                      onClick={() => {
                        setQuery("");
                        setNotice(null);
                        setExpanded(provider.id);
                      }}
                    >
                      <span className="text-foreground">{provider.label}</span>
                      <span className="font-mono text-muted-foreground">{provider.id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : query.trim() ? (
              <p className="text-xs text-muted-foreground">No other provider matches.</p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
