import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";
import {
  Check,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  Loader2,
  Plus,
  RadioTower,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { publishConnections } from "@/lib/connections";
import { cn } from "@/lib/utils";

type ConnectionsApi = NonNullable<NonNullable<Window["orkestrator"]>["connections"]>;
type TokenIntent = "replace" | "connect";

function getConnectionsApi(): ConnectionsApi | null {
  return window.orkestrator?.connections ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatLastConnected(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function ConnectionsSettings() {
  const api = getConnectionsApi();
  const [connections, setConnections] = useState<ConnectionList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [tokenTarget, setTokenTarget] = useState<ConnectionSummary | null>(null);
  const [tokenIntent, setTokenIntent] = useState<TokenIntent>("replace");
  const [removeTarget, setRemoveTarget] = useState<ConnectionSummary | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    setLoadError(null);
    try {
      setConnections(await api.list());
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const remoteCount = useMemo(
    () => connections?.connections.filter((connection) => connection.kind === "remote").length ?? 0,
    [connections],
  );
  const credentialStorage = connections?.credentialStorage ?? "session-only";

  const publish = (list: ConnectionList) => {
    setConnections(list);
    publishConnections(list);
  };

  const resetForm = () => {
    setAddress("");
    setToken("");
    setShowToken(false);
    setFormError(null);
  };

  const openAdd = () => {
    resetForm();
    setAddOpen(true);
  };

  const openToken = (connection: ConnectionSummary, intent: TokenIntent = "replace") => {
    resetForm();
    setTokenIntent(intent);
    setTokenTarget(connection);
  };

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!api) return;
    setBusyId("add");
    setFormError(null);
    try {
      await api.connect({ address, token });
      window.location.reload();
    } catch (error) {
      setFormError(errorMessage(error));
      setBusyId(null);
    }
  };

  const handleUpdateToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!api || !tokenTarget) return;
    setBusyId(tokenTarget.id);
    setFormError(null);
    try {
      const list = await api.updateToken(tokenTarget.id, token);
      publish(list);
      if (tokenIntent === "connect") {
        await api.use(tokenTarget.id);
        window.location.reload();
        return;
      }
      setTokenTarget(null);
      resetForm();
      setBusyId(null);
      toast.success("Saved gateway token", { description: tokenTarget.name });
    } catch (error) {
      setFormError(errorMessage(error));
      setBusyId(null);
    }
  };

  const handleUse = async (connection: ConnectionSummary) => {
    if (!api || connection.active) return;
    if (connection.requiresToken) {
      openToken(connection, "connect");
      return;
    }
    setBusyId(connection.id);
    try {
      await api.use(connection.id);
      window.location.reload();
    } catch (error) {
      setBusyId(null);
      toast.error("Could not switch servers", { description: errorMessage(error) });
    }
  };

  const handleRemove = async () => {
    if (!api || !removeTarget) return;
    const target = removeTarget;
    setBusyId(target.id);
    try {
      const list = await api.forget(target.id);
      if (target.active) {
        window.location.reload();
        return;
      }
      publish(list);
      setRemoveTarget(null);
      setBusyId(null);
      toast.success("Removed connection", { description: target.name });
    } catch (error) {
      setBusyId(null);
      toast.error("Could not remove connection", { description: errorMessage(error) });
    }
  };

  if (!api) {
    return (
      <div className="max-w-3xl rounded-lg border border-zinc-800 bg-zinc-950/40 p-5">
        <h3 className="text-sm font-medium text-foreground">Connections are unavailable</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          This client does not provide saved remote connections.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">Remote connections</h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Switch between Orkestrator backends and keep each gateway credential with its server.
          </p>
        </div>
        <Button type="button" onClick={openAdd} className="w-fit gap-2">
          <Plus className="h-4 w-4" />
          Add connection
        </Button>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm text-zinc-200">
            {credentialStorage === "secure"
              ? "Tokens are protected by your operating system’s credential storage."
              : "Tokens are kept only for this app session."}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
            Saved tokens cannot be revealed. Replacing a token verifies it with the server before
            storing it.
          </p>
        </div>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-red-500/25 bg-red-500/[0.07] p-4" role="alert">
          <p className="text-sm text-red-300">{loadError}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" />
            Try again
          </Button>
        </div>
      ) : !connections ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading connections…
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/30">
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/55 px-4 py-3">
            <span className="text-sm font-medium text-zinc-200">Servers</span>
            <span className="text-xs text-zinc-500">
              {remoteCount} remote {remoteCount === 1 ? "connection" : "connections"}
            </span>
          </div>
          <div className="divide-y divide-zinc-800/80">
            {connections.connections.map((connection) => {
              const lastConnected = formatLastConnected(connection.lastConnectedAt);
              const busy = busyId === connection.id;
              return (
                <div
                  key={connection.id}
                  className={cn(
                    "flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center",
                    connection.active && "bg-emerald-500/[0.035]",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
                      connection.active
                        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                        : "border-zinc-800 bg-zinc-900 text-zinc-400",
                    )}
                  >
                    {connection.kind === "local" ? (
                      <HardDrive className="h-4 w-4" />
                    ) : (
                      <RadioTower className="h-4 w-4" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100">{connection.name}</span>
                      {connection.active && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
                          <Check className="h-3 w-3" /> Current
                        </span>
                      )}
                      {connection.requiresToken && (
                        <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                          Token required
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-zinc-500">
                      {connection.address ?? "This device"}
                    </p>
                    {lastConnected && (
                      <p className="mt-1 text-[11px] text-zinc-600">
                        Last connected {lastConnected}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2 pl-12 sm:pl-0">
                    {!connection.active && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleUse(connection)}
                        disabled={busyId !== null}
                      >
                        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {connection.requiresToken ? "Enter token" : "Use"}
                      </Button>
                    )}
                    {connection.kind === "remote" && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-zinc-400 hover:text-zinc-100"
                          onClick={() => openToken(connection)}
                          disabled={busyId !== null}
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          Replace token
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-zinc-500 hover:bg-red-500/10 hover:text-red-300"
                          onClick={() => setRemoveTarget(connection)}
                          disabled={busyId !== null}
                          aria-label={`Remove ${connection.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={(open) => busyId !== "add" && setAddOpen(open)}>
        <DialogContent
          className={cn("max-w-md", Z_FULLSCREEN_DIALOG)}
          overlayClassName={Z_FULLSCREEN_DIALOG}
        >
          <form onSubmit={handleAdd}>
            <DialogHeader>
              <DialogTitle>Add connection</DialogTitle>
              <DialogDescription>
                Connect to an Orkestrator backend on your tailnet.
              </DialogDescription>
            </DialogHeader>
            <ConnectionFields
              address={address}
              onAddressChange={setAddress}
              token={token}
              onTokenChange={setToken}
              showToken={showToken}
              onShowTokenChange={setShowToken}
              disabled={busyId === "add"}
              error={formError}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setAddOpen(false)}
                disabled={busyId === "add"}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busyId === "add"}>
                {busyId === "add" && <Loader2 className="h-4 w-4 animate-spin" />}
                {busyId === "add" ? "Connecting…" : "Connect"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={tokenTarget !== null}
        onOpenChange={(open) => busyId === null && !open && setTokenTarget(null)}
      >
        <DialogContent
          className={cn("max-w-md", Z_FULLSCREEN_DIALOG)}
          overlayClassName={Z_FULLSCREEN_DIALOG}
        >
          <form onSubmit={handleUpdateToken}>
            <DialogHeader>
              <DialogTitle>
                {tokenIntent === "connect" ? "Enter gateway token" : "Replace gateway token"}
              </DialogTitle>
              <DialogDescription>
                {tokenIntent === "connect"
                  ? `Verify the credential for ${tokenTarget?.name}, then switch to that server.`
                  : `Update the saved credential for ${tokenTarget?.name}. This does not rotate the token on that server.`}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5 py-5">
              <div className="space-y-2">
                <Label htmlFor="replacement-connection-token">New gateway token</Label>
                <TokenInput
                  id="replacement-connection-token"
                  token={token}
                  onTokenChange={setToken}
                  showToken={showToken}
                  onShowTokenChange={setShowToken}
                  disabled={busyId !== null}
                />
              </div>
              {formError && <FormError message={formError} />}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setTokenTarget(null)}
                disabled={busyId !== null}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busyId !== null}>
                {busyId !== null && <Loader2 className="h-4 w-4 animate-spin" />}
                {busyId !== null
                  ? tokenIntent === "connect"
                    ? "Connecting…"
                    : "Verifying…"
                  : tokenIntent === "connect"
                    ? "Connect"
                    : "Save token"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The server address and its saved gateway token will be removed from this client.
              Nothing changes on the remote machine.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleRemove();
              }}
              disabled={busyId !== null}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              {busyId !== null && <Loader2 className="h-4 w-4 animate-spin" />}
              Remove connection
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConnectionFields({
  address,
  onAddressChange,
  token,
  onTokenChange,
  showToken,
  onShowTokenChange,
  disabled,
  error,
}: {
  address: string;
  onAddressChange: (value: string) => void;
  token: string;
  onTokenChange: (value: string) => void;
  showToken: boolean;
  onShowTokenChange: (value: boolean) => void;
  disabled: boolean;
  error: string | null;
}) {
  return (
    <div className="space-y-5 py-5">
      <div className="space-y-2">
        <Label htmlFor="settings-connection-address">Machine name or HTTPS address</Label>
        <Input
          id="settings-connection-address"
          type="text"
          inputMode="url"
          placeholder="workstation or https://workstation.tailnet.ts.net"
          value={address}
          onChange={(event) => onAddressChange(event.target.value)}
          autoComplete="url"
          disabled={disabled}
          required
        />
        <p className="text-xs leading-relaxed text-zinc-500">
          A machine name reuses the tailnet suffix from a saved connection. Use the full HTTPS
          origin the first time.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="settings-connection-token">Gateway token</Label>
        <TokenInput
          id="settings-connection-token"
          token={token}
          onTokenChange={onTokenChange}
          showToken={showToken}
          onShowTokenChange={onShowTokenChange}
          disabled={disabled}
        />
      </div>
      {error && <FormError message={error} />}
    </div>
  );
}

function TokenInput({
  id,
  token,
  onTokenChange,
  showToken,
  onShowTokenChange,
  disabled,
}: {
  id: string;
  token: string;
  onTokenChange: (value: string) => void;
  showToken: boolean;
  onShowTokenChange: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={showToken ? "text" : "password"}
        value={token}
        onChange={(event) => onTokenChange(event.target.value)}
        autoComplete="current-password"
        className="pr-10 font-mono text-xs"
        disabled={disabled}
        required
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-zinc-500 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500/60"
        onClick={() => onShowTokenChange(!showToken)}
        aria-label={showToken ? "Hide gateway token" : "Show gateway token"}
        disabled={disabled}
      >
        {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <div
      className="rounded-md border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-sm text-red-300"
      role="alert"
    >
      {message}
    </div>
  );
}
