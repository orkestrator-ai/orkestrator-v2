import { type FormEvent, useState } from "react";
import { ArrowDown, ArrowUp, Globe, Loader2, Plus, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  normalizeConnectionNickname,
  type ConnectionList,
  type ConnectionSummary,
} from "@orkestrator/protocol/connections";
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
import { Switch } from "@/components/ui/switch";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { reloadAfterConnectionChange } from "@/lib/client-platform";
import { publishConnections } from "@/lib/connections";
import { cn } from "@/lib/utils";
import { SshRouteDialog, errorCode } from "./SshRouteDialog";
import { FormError, MachineSection, TokenInput, errorText } from "./machine-ui";
import type { ConnectionsApi } from "./useMachines";

interface HostKeyReview {
  routeId: string;
  probeId: string;
  destination: string;
  fingerprints: Array<{ type: string; fingerprint: string }>;
}

/**
 * This device's own connection to a remote machine: the routes it uses to
 * open the machine in a window or switch this window to it, and the token it
 * keeps for that. Nothing here changes what the command node uses.
 */
export function DeviceConnectionSection({
  api,
  connection,
  current,
}: {
  api: ConnectionsApi;
  connection: ConnectionSummary;
  /** This window is connected to it. */
  current: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [nickname, setNickname] = useState(connection.nickname ?? "");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [review, setReview] = useState<HostKeyReview | null>(null);
  const [httpsOpen, setHttpsOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const routes = connection.routes ?? [];
  const verified = connection.identity === "verified";

  const routeAction = async (
    routeId: string,
    action: () => Promise<ConnectionList> | undefined,
  ) => {
    setBusy(routeId);
    try {
      const next = await action();
      if (next) publishConnections(next);
    } catch (error) {
      const route = routes.find((candidate) => candidate.id === routeId);
      // A first-use host key gets the same explicit fingerprint review as
      // onboarding, never an automatic accept.
      if (errorCode(error) === "host-key-unknown" && route?.sshDestination && api.probeSshHostKey) {
        try {
          const probe = await api.probeSshHostKey({
            destination: route.sshDestination,
            ...(route.sshPort ? { sshPort: route.sshPort } : {}),
          });
          setReview({ routeId, ...probe });
        } catch (probeError) {
          toast.error("Could not read the SSH host key", { description: errorText(probeError) });
        }
      } else {
        toast.error("Could not update the connection", { description: errorText(error) });
      }
    } finally {
      setBusy(null);
    }
  };

  const trustAndRetry = async () => {
    if (!review || !api.trustSshHostKey) return;
    const { routeId, probeId } = review;
    setReview(null);
    try {
      await api.trustSshHostKey(probeId);
    } catch (error) {
      toast.error("Could not trust the host key", { description: errorText(error) });
      return;
    }
    await routeAction(routeId, () => api.useRoute?.(connection.id, routeId));
  };

  const moveRoute = (index: number, delta: number) => {
    const order = routes.map((route) => route.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    void routeAction(routes[index]!.id, () => api.setRouteOrder?.(connection.id, order));
  };

  const saveToken = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("token");
    setTokenError(null);
    try {
      publishConnections(await api.updateToken(connection.id, token.trim()));
      setToken("");
      toast.success("Saved the token on this device", { description: connection.name });
    } catch (error) {
      setTokenError(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const saveNickname = async () => {
    if (!api.rename) return;
    setBusy("nickname");
    try {
      const normalized = normalizeConnectionNickname(nickname) ?? null;
      publishConnections(await api.rename(connection.id, normalized));
      toast.success("Saved the name on this device");
    } catch (error) {
      toast.error("Could not save the name", { description: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const useHere = async () => {
    setBusy("use");
    try {
      await api.use(connection.id);
      reloadAfterConnectionChange();
    } catch (error) {
      setBusy(null);
      toast.error("Could not switch this window", { description: errorText(error) });
    }
  };

  const forget = async () => {
    setBusy("forget");
    try {
      const list = await api.forget(connection.id);
      if (connection.active) {
        reloadAfterConnectionChange();
        return;
      }
      publishConnections(list);
      setForgetting(false);
      toast.success("Forgot it on this device", { description: connection.name });
    } catch (error) {
      toast.error("Could not forget it", { description: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  return (
    <MachineSection
      title="On this device"
      description="This device's own connection, used to open the machine in a window or switch this window to it. Saved on this device only."
      testId="machine-device-connection"
      action={
        !current ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || connection.requiresToken}
            onClick={() => void useHere()}
          >
            {busy === "use" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Connect this window
          </Button>
        ) : null
      }
    >
      {api.rename ? (
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor={`device-nickname-${connection.id}`}>Name on this device</Label>
            <Input
              id={`device-nickname-${connection.id}`}
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="Uses the machine's own name"
              disabled={disabled}
              className="h-8"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || nickname === (connection.nickname ?? "")}
            onClick={() => void saveNickname()}
          >
            Save
          </Button>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-300">Addresses</span>
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-xs"
              onClick={() => setHttpsOpen(true)}
              disabled={disabled || !verified}
              title={verified ? "Add an HTTPS address" : "Connect once to verify this machine"}
            >
              <Plus className="h-3 w-3" /> HTTPS
            </Button>
            {api.connectSsh ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs"
                onClick={() => setSshOpen(true)}
                disabled={disabled || !verified}
                title={verified ? "Add an SSH route" : "Connect once to verify this machine"}
              >
                <Plus className="h-3 w-3" /> SSH
              </Button>
            ) : null}
          </div>
        </div>
        <ul className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800/70">
          {routes.map((route, index) => (
            <li key={route.id} className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-xs">
              {route.kind === "ssh" ? (
                <Terminal className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
              ) : (
                <Globe className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">{route.label}</span>
              {route.active ? <span className="text-[11px] text-emerald-300">In use</span> : null}
              {!route.supported ? (
                <span className="text-zinc-500">Needs desktop SSH support</span>
              ) : null}
              <div className="ml-auto flex items-center gap-1">
                {!route.active && route.supported ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    disabled={disabled}
                    onClick={() =>
                      void routeAction(route.id, () => api.useRoute?.(connection.id, route.id))
                    }
                  >
                    {route.blockedReason ? "Retry" : "Use"}
                  </Button>
                ) : null}
                <Switch
                  checked={route.enabled}
                  aria-label={`${route.enabled ? "Disable" : "Enable"} ${route.label}`}
                  disabled={disabled}
                  onCheckedChange={(enabled) =>
                    void routeAction(route.id, () =>
                      api.setRouteEnabled?.(connection.id, route.id, enabled),
                    )
                  }
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  aria-label={`Prefer ${route.label} earlier`}
                  disabled={index === 0 || disabled}
                  onClick={() => moveRoute(index, -1)}
                >
                  <ArrowUp className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  aria-label={`Prefer ${route.label} later`}
                  disabled={index === routes.length - 1 || disabled}
                  onClick={() => moveRoute(index, 1)}
                >
                  <ArrowDown className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-zinc-500 hover:text-red-300"
                  aria-label={`Remove ${route.label} from this device`}
                  disabled={routes.length <= 1 || disabled}
                  title={
                    routes.length <= 1
                      ? "Forget the machine on this device to remove its last address"
                      : "Remove this address"
                  }
                  onClick={() =>
                    void routeAction(route.id, () => api.removeRoute?.(connection.id, route.id))
                  }
                >
                  {busy === route.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </Button>
              </div>
              {route.blockedReason ? (
                <span className="basis-full text-amber-300" role="alert">
                  Blocked: {route.blockedReason}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {connection.transportDetail ? (
          <p className="text-[11px] text-zinc-500">{connection.transportDetail}</p>
        ) : null}
      </div>

      <form className="space-y-1.5" onSubmit={(event) => void saveToken(event)}>
        <Label htmlFor={`device-token-${connection.id}`}>Connection token on this device</Label>
        <div className="flex gap-2">
          <div className="flex-1">
            <TokenInput
              id={`device-token-${connection.id}`}
              value={token}
              onChange={setToken}
              disabled={disabled}
              required
              placeholder={
                connection.requiresToken ? "Required" : "Saved — enter a new one to replace it"
              }
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={disabled || !token.trim()}>
            {busy === "token" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save token
          </Button>
        </div>
        <p className="text-[11px] text-zinc-500">
          Verified with the machine before it is stored. This does not change the token on the
          machine itself.
        </p>
        {tokenError ? <FormError message={tokenError} /> : null}
      </form>

      {typeof connection.autoConnect === "boolean" && api.setAutoConnect ? (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            <span className="text-zinc-200">Connect automatically</span>
            <span className="block text-xs text-zinc-500">
              Keep this device connected to it in the background.
            </span>
          </span>
          <Switch
            checked={connection.autoConnect}
            disabled={disabled}
            aria-label={`Connect ${connection.name} automatically`}
            onCheckedChange={(value) =>
              void routeAction("auto-connect", () => api.setAutoConnect?.(connection.id, value))
            }
          />
        </label>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-zinc-400 hover:bg-red-500/10 hover:text-red-300"
          disabled={disabled}
          onClick={() => setForgetting(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Forget on this device
        </Button>
      </div>

      <AddHttpsRouteDialog
        api={api}
        connection={connection}
        open={httpsOpen}
        onOpenChange={setHttpsOpen}
      />
      <SshRouteDialog open={sshOpen} onOpenChange={setSshOpen} machine={connection} />

      <Dialog open={review !== null} onOpenChange={(open) => !open && setReview(null)}>
        <DialogContent
          className={cn("sm:max-w-md", Z_FULLSCREEN_DIALOG)}
          overlayClassName={Z_FULLSCREEN_DIALOG}
        >
          <DialogHeader>
            <DialogTitle>Verify the SSH host key</DialogTitle>
            <DialogDescription>
              First connection to <span className="font-mono">{review?.destination}</span>. Compare
              the fingerprint with the machine before trusting it.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 rounded-md border border-zinc-800 bg-zinc-950/60 p-3 font-mono text-xs">
            {review?.fingerprints.map((entry) => (
              <li key={entry.fingerprint}>
                {entry.type} {entry.fingerprint}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setReview(null)}>
              Don’t trust
            </Button>
            <Button type="button" onClick={() => void trustAndRetry()}>
              Trust and connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={forgetting} onOpenChange={(open) => !open && setForgetting(false)}>
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget {connection.name} on this device?</AlertDialogTitle>
            <AlertDialogDescription>
              Its addresses and saved token are removed from this device only. This does not stop
              the machine&apos;s backend or agents, delete any of its data, or remove it from the
              command node.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disabled}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void forget();
              }}
              disabled={disabled}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              {busy === "forget" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Forget on this device
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MachineSection>
  );
}

/** Another HTTPS address for a verified machine; used only if it proves the same installation. */
function AddHttpsRouteDialog({
  api,
  connection,
  open,
  onOpenChange,
}: {
  api: ConnectionsApi;
  connection: ConnectionSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      publishConnections(
        await api.connect({ address, token, select: false, connectionId: connection.id }),
      );
      setAddress("");
      setToken("");
      onOpenChange(false);
      toast.success("Added an address", { description: connection.name });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className={cn("sm:max-w-md", Z_FULLSCREEN_DIALOG)}
        overlayClassName={Z_FULLSCREEN_DIALOG}
      >
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add an HTTPS address to {connection.name}</DialogTitle>
            <DialogDescription>
              Used only if it proves to be the same installation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="device-route-address">HTTPS address</Label>
            <Input
              id="device-route-address"
              inputMode="url"
              placeholder="https://workstation.tailnet.ts.net"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="device-route-token">Gateway token</Label>
            <TokenInput
              id="device-route-token"
              value={token}
              onChange={setToken}
              disabled={busy}
              required
            />
          </div>
          {error ? <FormError message={error} /> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Add address
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Saves a registered machine on this device too, so it can open in its own
 * window. The command node keeps its own token; this device needs one of
 * its own.
 */
export function SaveOnDeviceForm({
  api,
  origin,
  name,
}: {
  api: ConnectionsApi;
  origin: string;
  name: string;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      publishConnections(
        await api.connect({ address: origin, token: token.trim(), select: false }),
      );
      setToken("");
      toast.success("Saved on this device", { description: name });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <MachineSection
      title="On this device"
      description={`Save ${name} on this device to open it in its own window over a direct connection.`}
      testId="machine-save-on-device"
    >
      <form className="space-y-1.5" onSubmit={(event) => void submit(event)}>
        <Label htmlFor="save-on-device-token">Gateway token for {origin}</Label>
        <div className="flex gap-2">
          <div className="flex-1">
            <TokenInput
              id="save-on-device-token"
              value={token}
              onChange={setToken}
              disabled={busy}
              required
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !token.trim()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save on this device
          </Button>
        </div>
        {error ? <FormError message={error} /> : null}
      </form>
    </MachineSection>
  );
}
