import { type FormEvent, type ReactNode, useState } from "react";
import { Fingerprint, Globe, Loader2, ShieldAlert, Terminal } from "lucide-react";
import { toast } from "sonner";
import { normalizeMachineDisplayName } from "@orkestrator/protocol/backend-profile";
import {
  expandTailscaleMachineName,
  normalizeConnectionNickname,
  type ConnectionList,
} from "@orkestrator/protocol/connections";
import type { NodeRoute, NodeStatus } from "@orkestrator/protocol/command-nodes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import {
  addNode,
  nodeErrorText,
  probeNodeHostKey,
  setCommandNodeEnabled,
  trustNodeHostKey,
} from "@/lib/backend/command-nodes";
import { publishConnections } from "@/lib/connections";
import { errorCode } from "./SshRouteDialog";
import { NODE_STATE_TEXT } from "./machine-list";
import { FormError, TokenInput, errorText } from "./machine-ui";
import type { ConnectionsApi } from "./useMachines";

type RouteKind = "https" | "ssh";

interface HostKeyReview {
  probeId: string;
  destination: string;
  fingerprints: Array<{ type: string; fingerprint: string }>;
}

/** The node gateway port an SSH route forwards to on the other machine. */
const NODE_SSH_GATEWAY_PORT = "34122";
/** The loopback client port a device's own SSH route forwards to. */
const DEVICE_SSH_GATEWAY_PORT = "34125";

/**
 * Adds a machine over Tailscale/HTTPS or SSH.
 *
 * The command node this client is connected to registers it, connects to
 * it itself and keeps its token; it then shows in every multi-machine view.
 * On the desktop an HTTPS machine is also saved on this device, so it can
 * open in its own window. A backend without command nodes only gets the
 * device connection.
 */
export function AddMachineDialog({
  open,
  onOpenChange,
  status,
  api,
  knownAddresses,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null when the connected backend has no command-node support. */
  status: NodeStatus | null;
  api: ConnectionsApi | null;
  /** HTTPS addresses already known, whose tailnet suffix completes a bare machine name. */
  knownAddresses: readonly string[];
  onAdded: () => void;
}) {
  const [register, setRegister] = useState(true);
  const deviceOnly = status === null || !register;
  const [kind, setKind] = useState<RouteKind>("https");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [sshPort, setSshPort] = useState("");
  // Follows the default for where the machine is added until it is edited.
  const [editedRemotePort, setRemotePort] = useState<string | null>(null);
  const remotePort =
    editedRemotePort ?? (deviceOnly ? DEVICE_SSH_GATEWAY_PORT : NODE_SSH_GATEWAY_PORT);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [saveOnDevice, setSaveOnDevice] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [hostKey, setHostKey] = useState<HostKeyReview | null>(null);

  const leaf = !deviceOnly && status?.mode === "leaf";
  const registrationOff = !deviceOnly && status !== null && !leaf && !status.registrationEnabled;
  const sshAvailable = deviceOnly ? typeof api?.connectSsh === "function" : true;
  const canSaveOnDevice = !deviceOnly && kind === "https" && typeof api?.connect === "function";
  const blocked = leaf || registrationOff || (deviceOnly && !api);

  const reset = () => {
    setToken("");
    setError(null);
    setHostKey(null);
    setSaving(false);
  };

  const close = (next: boolean) => {
    if (saving) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const sshArgs = () => ({
    destination: destination.trim(),
    ...(sshPort.trim() ? { sshPort: Number(sshPort) } : {}),
  });

  // "workstation" becomes https://workstation.<tailnet>.ts.net from a known address.
  const httpsOrigin = () => {
    const expanded = expandTailscaleMachineName(origin, knownAddresses);
    const address = /^[a-z][a-z0-9+.-]*:\/\//i.test(expanded) ? expanded : `https://${expanded}`;
    return address.replace(/\/+$/, "");
  };

  const route = (): NodeRoute =>
    kind === "https"
      ? {
          id: "https" as NodeRoute["id"],
          kind: "https",
          enabled: true,
          origin: httpsOrigin(),
        }
      : {
          id: "ssh" as NodeRoute["id"],
          kind: "ssh",
          enabled: true,
          ...sshArgs(),
          remoteGatewayPort: Number(remotePort),
        };

  const addToDevice = async (displayName: string | undefined): Promise<ConnectionList> => {
    if (!api) throw new Error("This client cannot save machines itself.");
    const nickname = normalizeConnectionNickname(displayName);
    if (kind === "https") {
      return api.connect({
        address: httpsOrigin(),
        token: token.trim(),
        select: false,
        ...(nickname ? { nickname } : {}),
      });
    }
    if (!api.connectSsh) throw new Error("This client cannot use SSH routes.");
    return api.connectSsh({
      ...sshArgs(),
      remoteGatewayPort: Number(remotePort),
      token: token.trim(),
      select: false,
      ...(nickname ? { nickname } : {}),
    });
  };

  const reviewHostKey = async (failure: unknown) => {
    const text = deviceOnly ? errorText(failure) : nodeErrorText(failure);
    setError(text);
    const unknownKey = deviceOnly
      ? errorCode(failure) === "host-key-unknown"
      : /host key/i.test(text);
    if (kind !== "ssh" || !unknownKey) return;
    try {
      const probe = deviceOnly
        ? await api?.probeSshHostKey?.(sshArgs())
        : await probeNodeHostKey(sshArgs());
      if (probe) {
        setHostKey(probe);
        setError(null);
      }
    } catch {
      // The original error explains the failure.
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    let displayName: string | undefined;
    try {
      displayName = normalizeMachineDisplayName(name);
    } catch (failure) {
      setError(errorText(failure));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (deviceOnly) {
        publishConnections(await addToDevice(displayName));
        toast.success("Added machine on this device", {
          description: kind === "https" ? httpsOrigin() : destination.trim(),
        });
      } else {
        const view = await addNode({
          routes: [route()],
          token: token.trim(),
          ...(displayName ? { displayName } : {}),
        });
        toast.success(
          view.connection.state === "connected"
            ? `${view.displayName} is connected.`
            : `${view.displayName} was added: ${NODE_STATE_TEXT[view.connection.state]}.`,
        );
        if (canSaveOnDevice && saveOnDevice) {
          try {
            publishConnections(await addToDevice(displayName));
          } catch (failure) {
            toast.warning("It was not saved on this device", {
              description: `${errorText(failure)} It is still available through the command node.`,
            });
          }
        }
      }
      reset();
      onAdded();
      onOpenChange(false);
    } catch (failure) {
      await reviewHostKey(failure);
    } finally {
      setSaving(false);
    }
  };

  const trustHostKey = async () => {
    if (!hostKey) return;
    setSaving(true);
    try {
      if (deviceOnly) await api?.trustSshHostKey?.(hostKey.probeId);
      else await trustNodeHostKey(hostKey.probeId);
      setHostKey(null);
      setError(null);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  const enableRegistration = async () => {
    setEnabling(true);
    try {
      await setCommandNodeEnabled(true);
      onAdded();
    } catch (failure) {
      toast.error(nodeErrorText(failure));
    } finally {
      setEnabling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
        <form onSubmit={(event) => void submit(event)} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Add machine</DialogTitle>
            <DialogDescription>
              {deviceOnly
                ? "Connect this device to another Orkestrator backend."
                : "The machine you are connected to registers and attaches the new backend and keeps its token. The new backend enters leaf mode: if it controls other nodes, those subordinate links and command activity are suspended until it detaches. Existing agents keep running."}
            </DialogDescription>
          </DialogHeader>

          {status && api ? (
            <label className="flex items-start gap-3 text-sm">
              <Checkbox
                checked={deviceOnly}
                onCheckedChange={(checked) => {
                  setRegister(checked !== true);
                  setError(null);
                  setHostKey(null);
                }}
                disabled={saving}
                aria-label="Save on this device only"
              />
              <span>
                Save on this device only
                <span className="block text-xs text-zinc-500">
                  Connect directly without registration or attachment. The backend keeps control of
                  its subordinate nodes.
                </span>
              </span>
            </label>
          ) : null}

          {leaf ? (
            <Notice>
              This machine is controlled by{" "}
              {status?.controllers.map((controller) => controller.displayName).join(", ")}. Add
              machines there instead.
            </Notice>
          ) : registrationOff ? (
            <Notice
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={enabling}
                  onClick={() => void enableRegistration()}
                >
                  {enabling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Allow
                </Button>
              }
            >
              This machine is not allowed to command other machines yet.
            </Notice>
          ) : null}

          <SegmentedSelector
            ariaLabel="How to reach the machine"
            value={kind}
            onValueChange={(value) => {
              setKind(value);
              setError(null);
              setHostKey(null);
            }}
            disabled={saving}
            className="w-full"
            buttonClassName="flex-1"
            options={[
              {
                value: "https",
                label: "Tailscale / HTTPS",
                icon: <Globe className="h-3.5 w-3.5" />,
              },
              {
                value: "ssh",
                label: "SSH",
                icon: <Terminal className="h-3.5 w-3.5" />,
                disabled: !sshAvailable,
              },
            ]}
          />

          {kind === "https" ? (
            <div className="space-y-2">
              <Label htmlFor="add-machine-origin">Machine name or HTTPS address</Label>
              <Input
                id="add-machine-origin"
                inputMode="url"
                placeholder="workstation or https://workstation.tailnet.ts.net"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                autoComplete="url"
                disabled={saving}
                required
              />
              <p className="text-xs leading-relaxed text-zinc-500">
                The address Tailscale Serve (or another HTTPS proxy) publishes for that machine's
                Orkestrator. A bare machine name reuses the tailnet of a machine you already have.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-3">
                <Label htmlFor="add-machine-ssh-destination">SSH destination or alias</Label>
                <Input
                  id="add-machine-ssh-destination"
                  placeholder="build-box or user@build-box"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saving}
                  required
                />
                <p className="text-xs leading-relaxed text-zinc-500">
                  Uses your SSH configuration: aliases, keys and jump hosts.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-machine-ssh-port">SSH port</Label>
                <Input
                  id="add-machine-ssh-port"
                  inputMode="numeric"
                  placeholder="from config"
                  value={sshPort}
                  onChange={(event) => setSshPort(event.target.value)}
                  disabled={saving}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="add-machine-remote-port">Orkestrator port on that machine</Label>
                <Input
                  id="add-machine-remote-port"
                  inputMode="numeric"
                  value={remotePort}
                  onChange={(event) => setRemotePort(event.target.value)}
                  disabled={saving}
                  required
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="add-machine-token">Gateway token of that machine</Label>
            <TokenInput
              id="add-machine-token"
              value={token}
              onChange={setToken}
              disabled={saving}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-machine-name">
              Name <span className="font-normal text-zinc-500">(optional)</span>
            </Label>
            <Input
              id="add-machine-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Shown until the machine reports its own name"
              disabled={saving}
            />
          </div>

          {canSaveOnDevice ? (
            <label className="flex items-start gap-3 text-sm">
              <Checkbox
                checked={saveOnDevice}
                onCheckedChange={(checked) => setSaveOnDevice(checked === true)}
                disabled={saving}
                aria-label="Also save on this device"
                className="mt-0.5"
              />
              <span>
                <span className="text-zinc-200">Also save on this device</span>
                <span className="block text-xs text-zinc-500">
                  Lets this device open the machine in its own window over a direct connection.
                </span>
              </span>
            </label>
          ) : null}

          {hostKey ? (
            <div
              className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
              data-testid="add-machine-host-key"
            >
              <p className="flex items-center gap-2 font-medium text-zinc-100">
                <Fingerprint className="h-3.5 w-3.5" />
                First connection to {hostKey.destination}
              </p>
              <p className="text-zinc-300">
                Compare these host key fingerprints with the machine before trusting it:
              </p>
              <ul className="font-mono text-zinc-200">
                {hostKey.fingerprints.map((entry) => (
                  <li key={entry.fingerprint}>
                    {entry.type} {entry.fingerprint}
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => void trustHostKey()}
              >
                Trust this host key
              </Button>
              <p className="text-zinc-400">Then add the machine again.</p>
            </div>
          ) : null}

          {error ? <FormError message={error} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || blocked || hostKey !== null}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {saving ? "Connecting…" : "Add machine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <p className="flex-1">{children}</p>
      {action}
    </div>
  );
}
