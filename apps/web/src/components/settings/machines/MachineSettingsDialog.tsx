import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  BACKEND_PROFILE_CONFLICT_CODE,
  normalizeMachineDisplayName,
  parseBackendProfile,
  type BackendProfile,
} from "@orkestrator/protocol/backend-profile";
import type { NodeStatus } from "@orkestrator/protocol/command-nodes";
import type { HostMaintenanceSnapshot } from "@orkestrator/protocol/host-maintenance";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { forgetNode, nodeErrorText, reconnectNode, updateNode } from "@/lib/backend/command-nodes";
import { MACHINE_COLOR_CHOICES, machineDotClass } from "@/lib/federation/machine-colors";
import { cn } from "@/lib/utils";
import { CommandNodeSection } from "./CommandNodeSection";
import { DeviceConnectionSection, SaveOnDeviceForm } from "./DeviceConnectionSection";
import { NodeRoutesSection } from "./NodeRoutesSection";
import { machineInvoke } from "./machine-access";
import type { MachineEntry } from "./machine-list";
import { MachineSection, MachineStatusDot, errorText, formatMachineTime } from "./machine-ui";
import type { ConnectionsApi } from "./useMachines";

const MODE_TEXT = { standalone: "Standalone", command: "Command node", leaf: "Leaf" } as const;

const IDENTITY_TEXT = {
  verified: "Verified",
  provisional: "Not yet verified",
  conflict: "Conflict: another saved machine claims the same installation",
} as const;

/**
 * Everything about one machine: its shared name and colour, its state and
 * a ping, how the command node reaches it (addresses and token), this
 * device's own connection to it, and forgetting it.
 */
export function MachineSettingsDialog({
  machine,
  open,
  onOpenChange,
  api,
  status,
  snapshot,
  onChanged,
}: {
  machine: MachineEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: ConnectionsApi | null;
  status: NodeStatus | null;
  snapshot: HostMaintenanceSnapshot | null;
  onChanged: () => void;
}) {
  const node = machine.node;
  const connection = machine.connection;
  const origin = node?.routes.find((route) => route.kind === "https");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[88vh] flex-col gap-0 p-0 sm:p-0 sm:max-w-[min(42rem,calc(100%-2rem))]",
          Z_FULLSCREEN_DIALOG,
        )}
        overlayClassName={Z_FULLSCREEN_DIALOG}
      >
        <DialogHeader className="border-b border-zinc-800 px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2.5">
            <MachineStatusDot
              colorToken={machine.colorToken}
              connected={machine.connected}
              label={`${machine.name}: ${machine.statusText}`}
              decorative
            />
            {machine.name}
          </DialogTitle>
          <DialogDescription>
            {[machine.address, machine.via].filter(Boolean).join(" · ")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-7 overflow-y-auto px-6 py-5" data-testid="machine-settings">
          <ProfileSection machine={machine} onChanged={onChanged} />
          <StatusSection machine={machine} snapshot={snapshot} api={api} onChanged={onChanged} />
          {node ? <NodeRoutesSection key={node.nodeId} node={node} onSaved={onChanged} /> : null}
          {api && connection ? (
            <DeviceConnectionSection
              api={api}
              connection={connection}
              current={connection.active}
            />
          ) : api && !connection && node && origin?.kind === "https" ? (
            <SaveOnDeviceForm api={api} origin={origin.origin} name={machine.name} />
          ) : null}
          {machine.role === "self" && status ? (
            <CommandNodeSection status={status} onChanged={onChanged} />
          ) : null}
          {node ? (
            <ForgetNodeSection
              name={machine.name}
              nodeId={node.nodeId}
              onForgotten={() => {
                onOpenChange(false);
                onChanged();
              }}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The machine's own name and colour, stored on it and shared by every client. */
function ProfileSection({ machine, onChanged }: { machine: MachineEntry; onChanged: () => void }) {
  const reachable = machine.role === "self" || (machine.role === "node" && machine.connected);
  const call = useMemo(
    () => (reachable ? machineInvoke({ role: machine.role, nodeId: machine.nodeId }) : null),
    [machine.nodeId, machine.role, reachable],
  );
  const [profile, setProfile] = useState<BackendProfile | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(
    (): Promise<void> =>
      call
        ? call<unknown>("get_backend_profile").then(
            (value) => {
              setProfile(parseBackendProfile(value));
              setLoadFailed(false);
            },
            () => setLoadFailed(true),
          )
        : Promise.resolve(),
    [call],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (update: { displayName?: string; colorToken?: string }) => {
    if (!call || !profile) return;
    setSaving(true);
    try {
      const next = await call<unknown>("update_backend_profile", {
        expectedRevision: profile.revision,
        ...update,
      });
      setProfile(parseBackendProfile(next));
      setDraft(null);
      toast.success("Saved on the machine", {
        description: "Every client connected to it uses this name and colour.",
      });
      onChanged();
    } catch (error) {
      const text = errorText(error);
      if (text.includes(BACKEND_PROFILE_CONFLICT_CODE)) {
        // Someone else changed it first: show theirs instead of overwriting.
        setDraft(null);
        await load();
        toast.warning("This machine's name or colour changed on another client", {
          description: "The current values are shown; apply your change again if needed.",
        });
      } else {
        toast.error("Could not save the machine's profile", { description: text });
      }
    } finally {
      setSaving(false);
    }
  };

  const colorToken = profile?.colorToken ?? machine.colorToken;
  const editable = profile !== null && !saving;
  return (
    <MachineSection
      title="Name and colour"
      description="Stored on the machine itself, so every client shows the same name and dot colour."
      testId="machine-profile"
    >
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          let displayName: string | undefined;
          try {
            displayName = normalizeMachineDisplayName(draft ?? profile?.displayName ?? "");
          } catch (error) {
            toast.error(errorText(error));
            return;
          }
          if (!displayName) {
            toast.error("Enter a machine name.");
            return;
          }
          void save({ displayName });
        }}
      >
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={`machine-name-${machine.key}`}>Name</Label>
          <Input
            id={`machine-name-${machine.key}`}
            value={draft ?? profile?.displayName ?? machine.name}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!editable}
            className="h-8"
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!editable || draft === null || draft === profile?.displayName}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Rename
        </Button>
      </form>
      <div className="space-y-1.5">
        <span className="text-sm font-medium text-zinc-200">Dot colour</span>
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="radiogroup"
          aria-label="Dot colour"
        >
          {MACHINE_COLOR_CHOICES.map((choice) => (
            <button
              key={choice.token}
              type="button"
              role="radio"
              aria-checked={colorToken === choice.token}
              aria-label={choice.label}
              title={choice.label}
              disabled={!editable}
              onClick={() => {
                if (choice.token !== profile?.colorToken) void save({ colorToken: choice.token });
              }}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full border border-transparent disabled:opacity-40",
                colorToken === choice.token && "border-zinc-200",
              )}
            >
              <span className={cn("h-4 w-4 rounded-full", machineDotClass(choice.token))} />
            </button>
          ))}
        </div>
      </div>
      {!reachable ? (
        <p className="text-xs text-zinc-500">
          {machine.role === "device"
            ? "Add this machine to the command node to change its shared name and colour."
            : "Connect to this machine to change its name or colour."}
        </p>
      ) : loadFailed ? (
        <p className="text-xs text-zinc-500">
          This machine does not publish a shared profile. Update it to choose its name and colour.
        </p>
      ) : null}
    </MachineSection>
  );
}

/** State, how it is reached, a ping, and the switches that connect or reconnect it. */
function StatusSection({
  machine,
  snapshot,
  api,
  onChanged,
}: {
  machine: MachineEntry;
  snapshot: HostMaintenanceSnapshot | null;
  api: ConnectionsApi | null;
  onChanged: () => void;
}) {
  const node = machine.node;
  const connection = machine.connection;
  const [ping, setPing] = useState<{ ms: number } | { error: string } | null>(null);
  const [pinging, setPinging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const call = useMemo(
    () => machineInvoke({ role: machine.role, nodeId: machine.nodeId }),
    [machine.nodeId, machine.role],
  );
  const canPing = (call !== null && (machine.role === "self" || machine.connected)) || !!connection;

  const runPing = async () => {
    setPinging(true);
    const started = performance.now();
    try {
      if (call && (machine.role === "self" || machine.connected)) {
        await call("get_backend_profile");
      } else if (api && connection) {
        if (!(await api.probe(connection.id))) throw new Error("No answer");
      }
      setPing({ ms: Math.max(1, Math.round(performance.now() - started)) });
    } catch (error) {
      setPing({ error: errorText(error) });
    } finally {
      setPinging(false);
    }
  };

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      onChanged();
    } catch (error) {
      toast.error(nodeErrorText(error));
    } finally {
      setBusy(null);
    }
  };

  const rows: Array<[string, string]> = [["State", machine.statusText]];
  if (node?.connection.lastError && !machine.connected) {
    rows.push(["Last error", node.connection.lastError.message]);
  }
  rows.push(["Connected via", [machine.via, machine.address].filter(Boolean).join(" · ")]);
  if (machine.role === "node") rows.push(["Path", "Through the machine you are connected to"]);
  const lastConnected = formatMachineTime(machine.lastConnectedAt);
  rows.push([
    "Last connected",
    machine.role === "self" && machine.connected ? "Now" : (lastConnected ?? "Never"),
  ]);
  if (snapshot) rows.push(["Orkestrator", snapshot.version]);
  if (node?.connection.remoteMode) rows.push(["Mode", MODE_TEXT[node.connection.remoteMode]]);
  if (node && node.attachment.status !== "attached") {
    rows.push([
      "Attachment",
      node.attachment.status === "refused"
        ? `Refused (${node.attachment.reason ?? "unknown"})`
        : "Pending",
    ]);
  }
  if (connection?.identity) rows.push(["Identity", IDENTITY_TEXT[connection.identity]]);
  const lastHello = formatMachineTime(connection?.lastHelloAt);
  if (lastHello) rows.push(["Last handshake", lastHello]);
  if (connection?.latencyMs !== undefined) {
    rows.push(["Handshake round trip", `${connection.latencyMs} ms`]);
  }

  return (
    <MachineSection
      title="Status"
      testId="machine-status"
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={!canPing || pinging}
          onClick={() => void runPing()}
        >
          {pinging ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Activity className="h-3.5 w-3.5" />
          )}
          Ping
        </Button>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-zinc-500">{label}</dt>
            <dd className="min-w-0 truncate text-zinc-200">{value}</dd>
          </div>
        ))}
        {ping ? (
          <div className="contents">
            <dt className="text-zinc-500">Ping</dt>
            <dd
              data-testid="machine-ping"
              className={"error" in ping ? "text-red-300" : "font-mono text-zinc-200"}
            >
              {"error" in ping ? `No answer: ${ping.error}` : `${ping.ms} ms`}
            </dd>
          </div>
        ) : null}
      </dl>
      {node ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 px-3 py-2">
          <label
            className="flex items-center gap-3 text-sm"
            htmlFor={`node-enabled-${node.nodeId}`}
          >
            <Switch
              id={`node-enabled-${node.nodeId}`}
              checked={node.enabled}
              disabled={busy !== null}
              onCheckedChange={(enabled) =>
                void run("enabled", () => updateNode({ nodeId: node.nodeId, enabled }))
              }
            />
            <span>
              <span className="text-zinc-200">Keep connected</span>
              <span className="block text-xs text-zinc-500">
                Off disconnects it here. Nothing on the machine stops.
              </span>
            </span>
          </label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="gap-1.5"
            disabled={busy !== null || !node.enabled}
            onClick={() => void run("reconnect", () => reconnectNode(node.nodeId))}
          >
            {busy === "reconnect" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Reconnect
          </Button>
        </div>
      ) : null}
    </MachineSection>
  );
}

function ForgetNodeSection({
  name,
  nodeId,
  onForgotten,
}: {
  name: string;
  nodeId: string;
  onForgotten: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const forget = async () => {
    setBusy(true);
    try {
      await forgetNode(nodeId, { withoutDetach: false });
      toast.success(`${name} was removed. Nothing on it was stopped.`);
      setOpen(false);
      onForgotten();
    } catch (error) {
      toast.error(nodeErrorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex items-center justify-between gap-3 rounded-md border border-red-500/20 px-3 py-3">
      <div>
        <p className="text-sm text-zinc-200">Remove machine</p>
        <p className="text-xs text-zinc-500">
          The command node stops controlling it and drops its token. Nothing on it is stopped or
          deleted.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="shrink-0 text-red-300 hover:bg-red-500/10 hover:text-red-200"
        onClick={() => setOpen(true)}
        aria-label={`Remove ${name}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <AlertDialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The command node stops controlling it and drops its token. Nothing on {name} is
              stopped or deleted. It is told to detach now, or as soon as it is reachable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void forget();
              }}
              disabled={busy}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
