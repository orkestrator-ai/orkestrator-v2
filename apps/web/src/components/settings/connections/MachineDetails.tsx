import { useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Network, Plus, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  BACKEND_PROFILE_CONFLICT_CODE,
  normalizeMachineDisplayName,
} from "@orkestrator/protocol/backend-profile";
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorCode } from "./SshRouteDialog";
import { MachineDot } from "@/components/federation/MachineDot";
import { useFederation } from "@/components/federation/FederationProvider";
import { updateBackendProfile } from "@/lib/backend";
import { MACHINE_COLOR_CHOICES, machineDotClass } from "@/lib/federation/machine-colors";
import { publishConnections } from "@/lib/connections";
import { cn } from "@/lib/utils";

type ConnectionsApi = NonNullable<NonNullable<Window["orkestrator"]>["connections"]>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const IDENTITY_TEXT: Record<NonNullable<ConnectionSummary["identity"]>, string> = {
  verified: "Identity verified",
  provisional: "Identity not yet verified (older backend or not connected)",
  conflict: "Identity conflict: another saved machine claims the same installation",
};

/**
 * One machine's shared profile and this device's routes to it.
 *
 * The name and colour are stored on the machine itself, so every client
 * with access sees the same; edits are compare-and-swap on the profile
 * revision and need the machine online. Routes and their credentials are
 * this device's own.
 */
export function MachineDetails({
  connection,
  duplicateColorWith,
  onAddRoute,
  showRoutes = true,
  sshSupported = false,
}: {
  connection: ConnectionSummary;
  /** This client manages routes itself (desktop); a browser has one HTTPS route per machine. */
  showRoutes?: boolean;
  /** Other machines using the same colour, for a suggestion only. */
  duplicateColorWith: readonly string[];
  onAddRoute?: (kind: "https" | "ssh") => void;
  /** This client can open managed SSH routes. */
  sshSupported?: boolean;
}) {
  const api: ConnectionsApi | null = window.orkestrator?.connections ?? null;
  const { portal, portalState, bound } = useFederation();
  const [draftName, setDraftName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyRoute, setBusyRoute] = useState<string | null>(null);
  const isBound = Boolean(bound && connection.backendId === bound.backendId);
  // A registered node's profile is edited through the command node, which
  // sees its profile events first; edits carry the freshest revision.
  const node = portalState.nodes.find((entry) => entry.nodeId === connection.backendId);
  const profile = connection.profile;
  const live = connection.transport === "connected" || isBound || node?.available === true;

  const saveProfile = async (update: { displayName?: string; colorToken?: string }) => {
    if (!profile) return;
    setSaving(true);
    try {
      const payload = { expectedRevision: profile.revision, ...update };
      if (isBound) {
        await updateBackendProfile(payload as Parameters<typeof updateBackendProfile>[0]);
      } else if (node && connection.backendId) {
        await portal.invokeOnNode(connection.backendId, "update_backend_profile", payload);
      } else {
        throw new Error(
          "Connect to this machine, or register it as a node in Nodes, to edit its profile.",
        );
      }
      setDraftName(null);
      toast.success("Saved on the machine", {
        description: "Every client connected to it uses this name and colour.",
      });
    } catch (error) {
      const text = message(error);
      if (text.includes(BACKEND_PROFILE_CONFLICT_CODE)) {
        // Someone else changed it first: show theirs instead of overwriting.
        setDraftName(null);
        toast.warning("This machine's profile changed on another client", {
          description: "The current name and colour are shown; apply your change again if needed.",
        });
      } else {
        toast.error("Could not save the machine profile", { description: text });
      }
    } finally {
      setSaving(false);
    }
  };

  const [review, setReview] = useState<{
    routeId: string;
    probeId: string;
    destination: string;
    fingerprints: Array<{ type: string; fingerprint: string }>;
  } | null>(null);

  const routeAction = async (
    routeId: string,
    action: () => Promise<ConnectionList> | undefined,
  ) => {
    setBusyRoute(routeId);
    try {
      const next = await action();
      if (next) publishConnections(next);
    } catch (error) {
      const route = (connection.routes ?? []).find((candidate) => candidate.id === routeId);
      // A first-use host key on an existing SSH route gets the same explicit
      // fingerprint review as onboarding, never an automatic accept.
      if (
        errorCode(error) === "host-key-unknown" &&
        route?.sshDestination &&
        api?.probeSshHostKey
      ) {
        try {
          const probe = await api.probeSshHostKey({
            destination: route.sshDestination,
            ...(route.sshPort ? { sshPort: route.sshPort } : {}),
          });
          setReview({ routeId, ...probe });
        } catch (probeError) {
          toast.error("Could not read the SSH host key", { description: message(probeError) });
        }
      } else {
        toast.error("Could not update the connection method", { description: message(error) });
      }
    } finally {
      setBusyRoute(null);
    }
  };

  const trustAndRetry = async () => {
    if (!review || !api?.trustSshHostKey) return;
    const { routeId, probeId } = review;
    setReview(null);
    try {
      await api.trustSshHostKey(probeId);
    } catch (error) {
      toast.error("Could not trust the host key", { description: message(error) });
      return;
    }
    await routeAction(routeId, () => api.useRoute?.(connection.id, routeId));
  };

  const routes = connection.routes ?? [];
  const moveRoute = (index: number, delta: number) => {
    const order = routes.map((route) => route.id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    void routeAction(routes[index]!.id, () => api?.setRouteOrder?.(connection.id, order));
  };

  return (
    <div
      className="mt-3 space-y-4 rounded-md border border-zinc-800/80 bg-zinc-950/40 p-3"
      data-testid="machine-details"
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <MachineDot
            colorToken={profile?.colorToken}
            machineName={profile?.displayName ?? connection.name}
          />
          <span className="font-medium text-zinc-200">Machine profile</span>
          {profile?.cached ? <span className="text-zinc-500">(last known)</span> : null}
          <span className="text-zinc-500">
            · {IDENTITY_TEXT[connection.identity ?? "provisional"]}
          </span>
        </div>
        {profile ? (
          <>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  const displayName = normalizeMachineDisplayName(draftName ?? profile.displayName);
                  if (!displayName) throw new Error("Enter a machine name.");
                  void saveProfile({ displayName });
                } catch (error) {
                  toast.error(message(error));
                }
              }}
            >
              <Input
                aria-label="Machine name (shared)"
                value={draftName ?? profile.displayName}
                onChange={(event) => setDraftName(event.target.value)}
                disabled={!live || saving}
                maxLength={64}
                className="h-8 max-w-xs"
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={
                  !live || saving || draftName === null || draftName === profile.displayName
                }
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save name
              </Button>
            </form>
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="radiogroup"
              aria-label="Machine colour (shared)"
            >
              {MACHINE_COLOR_CHOICES.map((choice) => (
                <button
                  key={choice.token}
                  type="button"
                  role="radio"
                  aria-checked={profile.colorToken === choice.token}
                  aria-label={choice.label}
                  title={choice.label}
                  disabled={!live || saving}
                  onClick={() => {
                    if (choice.token !== profile.colorToken)
                      void saveProfile({ colorToken: choice.token });
                  }}
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full border border-transparent disabled:opacity-40",
                    profile.colorToken === choice.token && "border-zinc-200",
                  )}
                >
                  <span className={cn("h-3.5 w-3.5 rounded-full", machineDotClass(choice.token))} />
                </button>
              ))}
            </div>
            {!live ? (
              <p className="text-[11px] text-zinc-500">
                Connect to this machine to change its shared name or colour.
              </p>
            ) : null}
            {duplicateColorWith.length > 0 ? (
              <p className="text-[11px] text-amber-300/90" role="note">
                {duplicateColorWith.join(", ")} {duplicateColorWith.length === 1 ? "uses" : "use"}{" "}
                the same colour. Names still tell them apart; pick another colour if that helps.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-[11px] text-zinc-500">
            This backend does not publish a shared profile. Update it to choose a machine colour.
          </p>
        )}
      </div>

      <MachineDiagnostics connection={connection} />
      <Dialog open={review !== null} onOpenChange={(open) => !open && setReview(null)}>
        <DialogContent className="sm:max-w-md">
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

      {connection.kind === "remote" && showRoutes ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-200">
              Connection methods on this device
            </span>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs"
                onClick={() => onAddRoute?.("https")}
                disabled={connection.identity !== "verified"}
                title={
                  connection.identity === "verified"
                    ? "Add an HTTPS route"
                    : "Connect once to verify this machine first"
                }
              >
                <Plus className="h-3 w-3" /> HTTPS
              </Button>
              {sshSupported ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 text-xs"
                  onClick={() => onAddRoute?.("ssh")}
                  disabled={connection.identity !== "verified"}
                  title={
                    connection.identity === "verified"
                      ? "Add an SSH route"
                      : "Connect once to verify this machine first"
                  }
                >
                  <Plus className="h-3 w-3" /> SSH
                </Button>
              ) : null}
            </div>
          </div>
          <ul className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800/70">
            {routes.map((route, index) => (
              <li key={route.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs">
                {route.kind === "ssh" ? (
                  <Terminal className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                ) : (
                  <Network className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">
                  {route.label}
                </span>
                {route.active ? <span className="text-emerald-300">Active</span> : null}
                {!route.supported ? (
                  <span className="text-zinc-500">Requires desktop SSH support</span>
                ) : null}
                {route.blockedReason ? (
                  <span className="basis-full text-amber-300" role="alert">
                    Blocked: {route.blockedReason}
                  </span>
                ) : null}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    aria-label={`Prefer ${route.label} earlier`}
                    disabled={index === 0 || busyRoute !== null}
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
                    disabled={index === routes.length - 1 || busyRoute !== null}
                    onClick={() => moveRoute(index, 1)}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  {!route.active && route.supported ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      disabled={busyRoute !== null}
                      onClick={() =>
                        void routeAction(route.id, () => api?.useRoute?.(connection.id, route.id))
                      }
                    >
                      {route.blockedReason ? "Retry" : "Use"}
                    </Button>
                  ) : null}
                  <Switch
                    checked={route.enabled}
                    aria-label={`${route.enabled ? "Disable" : "Enable"} ${route.label}`}
                    disabled={busyRoute !== null}
                    onCheckedChange={(enabled) =>
                      void routeAction(route.id, () =>
                        api?.setRouteEnabled?.(connection.id, route.id, enabled),
                      )
                    }
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-zinc-500 hover:text-red-300"
                    aria-label={`Remove ${route.label} from this device`}
                    disabled={routes.length <= 1 || busyRoute !== null}
                    title={
                      routes.length <= 1
                        ? "Forget the machine to remove its last method"
                        : "Remove this method"
                    }
                    onClick={() =>
                      void routeAction(route.id, () => api?.removeRoute?.(connection.id, route.id))
                    }
                  >
                    {busyRoute === route.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {connection.transportDetail ? (
            <p className="text-[11px] text-zinc-500">{connection.transportDetail}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Sanitized connection diagnostics: state, last handshake, round trip,
 * backend generation and negotiated capabilities. Never credentials, paths
 * or raw transport errors.
 */
function MachineDiagnostics({ connection }: { connection: ConnectionSummary }) {
  const api: ConnectionsApi | null = window.orkestrator?.connections ?? null;
  const [busy, setBusy] = useState(false);
  const lastHello = connection.lastHelloAt ? new Date(connection.lastHelloAt) : null;
  const rows: Array<[string, string]> = [
    ["State", (connection.transport ?? "unknown").replace(/-/g, " ")],
  ];
  if (lastHello && !Number.isNaN(lastHello.getTime())) {
    rows.push(["Last handshake", lastHello.toLocaleString()]);
  }
  if (connection.latencyMs !== undefined) rows.push(["Round trip", `${connection.latencyMs} ms`]);
  if (connection.generation) rows.push(["Backend generation", connection.generation.slice(0, 12)]);
  if (connection.capabilities) {
    rows.push(["Capabilities", connection.capabilities.join(", ") || "none"]);
  }
  return (
    <div className="space-y-1.5" data-testid="machine-diagnostics">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-200">Connection</span>
        {connection.kind === "remote" &&
        typeof connection.autoConnect === "boolean" &&
        api?.setAutoConnect ? (
          <label className="flex items-center gap-2 text-[11px] text-zinc-400">
            Connect automatically
            <Switch
              checked={connection.autoConnect}
              disabled={busy}
              aria-label={`Connect ${connection.name} automatically`}
              onCheckedChange={(value) => {
                setBusy(true);
                void api.setAutoConnect!(connection.id, value)
                  .then(publishConnections, (error: unknown) =>
                    toast.error("Could not change the setting", { description: message(error) }),
                  )
                  .finally(() => setBusy(false));
              }}
            />
          </label>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-zinc-500">{label}</dt>
            <dd className="truncate font-mono text-zinc-300">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
