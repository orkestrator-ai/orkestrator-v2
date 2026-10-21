import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Loader2, Network, Plus, RefreshCw, Settings2, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  NODE_SSH_PROMPT_EVENT,
  NODE_STATUS_CHANGED_EVENT,
  NODES_CHANGED_EVENT,
  type NodeConnectionState,
  type NodeListResult,
  type NodeRoute,
  type NodeStatus,
  type NodeView,
} from "@orkestrator/protocol/command-nodes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { MachineDot } from "@/components/federation/MachineDot";
import {
  addNode,
  allowController,
  answerNodeSshPrompt,
  detachControllerHere,
  discardNodeDetach,
  forgetNode,
  getNodeStatus,
  listNodes,
  listNodeSshPrompts,
  nodeErrorText,
  probeNodeHostKey,
  reconnectNode,
  setCommandNodeEnabled,
  trustNodeHostKey,
  updateNode,
} from "@/lib/backend/command-nodes";
import { portalListen, portalListenAuthoritative } from "@/lib/portal/portal-transport";
import { EditNodeDialog } from "./EditNodeDialog";

/**
 * Command-node settings of the backend this client is connected to.
 *
 * The registry, routes and credentials of other nodes are kept by that
 * backend (docs/architecture/command-nodes.md). This page manages them and,
 * when this node is itself controlled by command nodes, lists those and lets
 * the user detach them here.
 */

const errorText = nodeErrorText;

const STATE_TEXT: Record<NodeConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  degraded: "Degraded",
  unavailable: "Unavailable",
  quarantined: "Blocked: identity or trust check failed",
  "needs-credential": "Needs a gateway token",
  "needs-update": "Needs an Orkestrator update",
  suspended: "Suspended (this node is in leaf mode)",
  disabled: "Disabled",
};

const MODE_TEXT: Record<NodeStatus["mode"], string> = {
  standalone: "Standalone",
  command: "Command node",
  leaf: "Leaf mode",
};

function formatTime(value: string | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function routeLabel(node: NodeView): string {
  const route = node.routes.find((entry) => entry.id === node.connection.activeRouteId);
  if (!route) return node.routes.length === 1 ? "1 route" : `${node.routes.length} routes`;
  return route.kind === "https"
    ? `HTTPS ${new URL(route.origin).host}`
    : `SSH ${route.destination}`;
}

export function NodesSettings() {
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [nodes, setNodes] = useState<NodeListResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextNodes] = await Promise.all([getNodeStatus(), listNodes()]);
      setStatus(nextStatus);
      setNodes(nextNodes);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unlisten: Array<() => void> = [];
    let cancelled = false;
    for (const event of [NODES_CHANGED_EVENT, NODE_STATUS_CHANGED_EVENT]) {
      void portalListen(event, () => void refresh()).then((stop) => {
        if (cancelled) stop();
        else unlisten.push(stop);
      });
    }
    return () => {
      cancelled = true;
      for (const stop of unlisten) stop();
    };
  }, [refresh]);

  const run = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await action();
      if (success) toast.success(success);
      await refresh();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  if (loadError && !status) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-5">
        <h3 className="text-sm font-medium text-foreground">Command node</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          This backend does not support command nodes yet: {loadError}
        </p>
      </section>
    );
  }
  if (!status || !nodes) {
    return (
      <section className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading command-node settings…
      </section>
    );
  }

  const leaf = status.mode === "leaf";
  return (
    <section className="space-y-4" data-testid="nodes-settings">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Network className="h-4 w-4" /> Nodes
            <span
              data-testid="node-mode"
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs font-normal text-muted-foreground"
            >
              {MODE_TEXT[status.mode]}
            </span>
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            A command node keeps a registry of the machines it controls and connects to them itself.
            Their tokens stay on this node; clients never receive them. Forgetting a node never
            stops or deletes anything on it.
          </p>
        </div>
        {!leaf && status.registrationEnabled ? (
          <Button
            type="button"
            variant="outline"
            className="w-fit gap-2"
            onClick={() => setAdding(true)}
          >
            <Plus className="h-4 w-4" /> Add node
          </Button>
        ) : null}
      </div>

      {leaf ? (
        <div
          data-testid="leaf-mode-notice"
          className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            This node is controlled by{" "}
            {status.controllers.map((controller) => controller.displayName).join(", ")} and is in
            leaf mode. Its own command activity is suspended
            {status.suspendedSubordinateCount > 0
              ? ` (${status.suspendedSubordinateCount} registered node${status.suspendedSubordinateCount === 1 ? "" : "s"} kept, not controlled)`
              : ""}
            . Coordination happens on the command node.
          </p>
        </div>
      ) : (
        <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 p-3 text-sm">
          <span>
            <span className="font-medium text-foreground">Allow this node to command others</span>
            <span className="block text-xs text-muted-foreground">
              Any node with registered nodes is a command node. The desktop app's own backend always
              allows it.
            </span>
          </span>
          <Switch
            checked={status.registrationEnabled}
            disabled={busy === "registration"}
            onCheckedChange={(checked) =>
              void run("registration", () => setCommandNodeEnabled(checked))
            }
            aria-label="Allow this node to command others"
          />
        </label>
      )}

      {nodes.nodes.length > 0 ? (
        <ul
          className="divide-y divide-zinc-800 rounded-lg border border-zinc-800"
          data-testid="node-list"
        >
          {nodes.nodes.map((node) => (
            <li
              key={node.nodeId}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <MachineDot colorToken={node.colorToken} machineName={node.displayName} />
                  <span className="truncate">{node.displayName}</span>
                </div>
                <p className="text-xs text-muted-foreground" data-testid="node-state">
                  {STATE_TEXT[node.connection.state]} · {routeLabel(node)}
                  {node.attachment.status === "refused"
                    ? ` · attachment refused (${node.attachment.reason ?? "unknown"})`
                    : ""}
                  {node.connection.remoteMode === "leaf" ? " · leaf mode" : ""}
                </p>
                {node.connection.lastError && node.connection.state !== "connected" ? (
                  <p className="text-xs text-muted-foreground">
                    {node.connection.lastError.message}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Last connected {formatTime(node.lastConnectedAt)}
                  {node.source === "desktop-migration" ? " · imported from this desktop" : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  checked={node.enabled}
                  disabled={busy === node.nodeId || leaf}
                  onCheckedChange={(enabled) =>
                    void run(node.nodeId, () => updateNode({ nodeId: node.nodeId, enabled }))
                  }
                  aria-label={`Connect to ${node.displayName}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy === node.nodeId || leaf || !node.enabled}
                  onClick={() => void run(node.nodeId, () => reconnectNode(node.nodeId))}
                  aria-label={`Reconnect ${node.displayName}`}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <EditNodeButton node={node} onSaved={() => void refresh()} />
                <ForgetNodeButton
                  node={node}
                  onForget={(withoutDetach) =>
                    run(
                      node.nodeId,
                      () => forgetNode(node.nodeId, { withoutDetach }),
                      `${node.displayName} was forgotten here. Nothing on it was stopped.`,
                    )
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      ) : !leaf ? (
        <p className="text-sm text-muted-foreground">No nodes are registered on this node.</p>
      ) : null}

      {nodes.pendingDetaches.length > 0 ? (
        <div className="rounded-lg border border-zinc-800 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Waiting to detach</p>
          {nodes.pendingDetaches.map((entry) => (
            <div key={entry.nodeId} className="mt-1 flex items-center justify-between gap-2">
              <span>
                {entry.displayName} was forgotten {formatTime(entry.forgottenAt)}; it will be told
                when it is reachable.
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void run(entry.nodeId, () => discardNodeDetach(entry.nodeId))}
              >
                Stop waiting
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {status.controllers.length > 0 || status.detachedControllers.length > 0 ? (
        <div className="space-y-2" data-testid="controllers">
          <h4 className="text-sm font-medium text-foreground">Controlled by</h4>
          {status.controllers.map((controller) => (
            <div
              key={controller.controllerId}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 p-3 text-sm"
            >
              <span>
                {controller.displayName}
                <span className="block text-xs text-muted-foreground">
                  Attached {formatTime(controller.attachedAt)} · last contact{" "}
                  {formatTime(controller.lastContactAt)}
                  {controller.controllerId === status.mostRecentControllerId
                    ? " (most recent)"
                    : ""}
                </span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy === controller.controllerId}
                onClick={() =>
                  void run(
                    controller.controllerId,
                    () => detachControllerHere(controller.controllerId),
                    `Detached ${controller.displayName}. Work on this node keeps running.`,
                  )
                }
              >
                Detach
              </Button>
            </div>
          ))}
          {status.detachedControllers.map((controller) => (
            <div
              key={controller.controllerId}
              className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-zinc-800 p-3 text-xs text-muted-foreground"
            >
              <span>
                {controller.displayName} was detached here {formatTime(controller.detachedAt)} and
                cannot attach again.
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  void run(controller.controllerId, () => allowController(controller.controllerId))
                }
              >
                Allow again
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <AddNodeDialog open={adding} onOpenChange={setAdding} onAdded={() => void refresh()} />
    </section>
  );
}

function EditNodeButton({ node, onSaved }: { node: NodeView; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Edit routes to ${node.displayName}`}
      >
        <Settings2 className="h-4 w-4" />
      </Button>
      {open ? (
        <EditNodeDialog node={node} open={open} onOpenChange={setOpen} onSaved={onSaved} />
      ) : null}
    </>
  );
}

function ForgetNodeButton({
  node,
  onForget,
}: {
  node: NodeView;
  onForget: (withoutDetach: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Forget ${node.displayName}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
          <DialogHeader>
            <DialogTitle>Forget {node.displayName}?</DialogTitle>
            <DialogDescription>
              This node stops controlling it and drops its token. Nothing on {node.displayName} is
              stopped or deleted. It is told to detach now, or as soon as it is reachable.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setOpen(false);
                void onForget(false);
              }}
            >
              Forget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type RouteKind = "https" | "ssh";

function AddNodeDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<RouteKind>("https");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [remotePort, setRemotePort] = useState("34122");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hostKey, setHostKey] = useState<Awaited<ReturnType<typeof probeNodeHostKey>> | null>(null);

  const reset = () => {
    setToken("");
    setError(null);
    setHostKey(null);
    setSaving(false);
  };

  const route = (): NodeRoute =>
    kind === "https"
      ? {
          id: "https" as never,
          kind: "https",
          enabled: true,
          origin: origin.trim().replace(/\/$/, ""),
        }
      : {
          id: "ssh" as never,
          kind: "ssh",
          enabled: true,
          destination: destination.trim(),
          ...(sshPort.trim() ? { sshPort: Number(sshPort) } : {}),
          remoteGatewayPort: Number(remotePort),
        };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const view = await addNode({
        routes: [route()],
        token: token.trim(),
        ...(name.trim() ? { displayName: name.trim() } : {}),
      });
      setToken("");
      toast.success(
        view.connection.state === "connected"
          ? `${view.displayName} is attached to this node.`
          : `${view.displayName} was registered: ${STATE_TEXT[view.connection.state]}.`,
      );
      onAdded();
      onOpenChange(false);
      reset();
    } catch (failure) {
      const text = errorText(failure);
      setError(text);
      if (kind === "ssh" && /host key/i.test(text)) {
        try {
          setHostKey(
            await probeNodeHostKey({
              destination: destination.trim(),
              ...(sshPort.trim() ? { sshPort: Number(sshPort) } : {}),
            }),
          );
        } catch {
          // The original error explains the failure.
        }
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add a node</DialogTitle>
            <DialogDescription>
              This node connects to the other machine itself, verifies its identity and attaches it.
              If that machine commands nodes of its own, it switches to leaf mode.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            {(["https", "ssh"] as const).map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={kind === option ? "default" : "outline"}
                onClick={() => setKind(option)}
              >
                {option === "https" ? "HTTPS / Tailscale" : "SSH"}
              </Button>
            ))}
          </div>
          {kind === "https" ? (
            <div className="space-y-1">
              <Label htmlFor="node-origin">Address</Label>
              <Input
                id="node-origin"
                placeholder="https://build-box.tailnet.ts.net"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                required
              />
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-3">
                <Label htmlFor="node-ssh-destination">SSH destination or alias</Label>
                <Input
                  id="node-ssh-destination"
                  placeholder="build-box"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="node-ssh-port">SSH port</Label>
                <Input
                  id="node-ssh-port"
                  inputMode="numeric"
                  placeholder="from config"
                  value={sshPort}
                  onChange={(event) => setSshPort(event.target.value)}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="node-remote-port">Remote gateway port</Label>
                <Input
                  id="node-remote-port"
                  inputMode="numeric"
                  value={remotePort}
                  onChange={(event) => setRemotePort(event.target.value)}
                  required
                />
              </div>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="node-token">Gateway token of that machine</Label>
            <Input
              id="node-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="node-name">Name before it connects (optional)</Label>
            <Input id="node-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          {hostKey ? (
            <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
              <p className="font-medium text-foreground">
                First connection to {hostKey.destination}. Compare these host key fingerprints with
                the machine before trusting it:
              </p>
              <ul className="font-mono">
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
                onClick={() =>
                  void trustNodeHostKey(hostKey.probeId).then(
                    () => {
                      setHostKey(null);
                      setError("Host key trusted. Add the node again.");
                    },
                    (failure: unknown) => setError(errorText(failure)),
                  )
                }
              >
                Trust this host key
              </Button>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Add node
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface PromptEvent {
  promptId: string;
  nodeId: string;
  kind: string;
  message: string;
  state: "open" | "closed";
}

/** SSH prompts raised by this node's own tunnels to other nodes. Answers are never stored. */
export function NodeSshPromptDialog() {
  const [prompts, setPrompts] = useState<PromptEvent[]>([]);
  const prompt = prompts[0] ?? null;
  const [draft, setDraft] = useState({ promptId: "", value: "" });
  const answer = draft.promptId === prompt?.promptId ? draft.value : "";
  const setAnswer = (value: string) => setDraft({ promptId: prompt?.promptId ?? "", value });

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    let revision = 0;
    const refresh = async (): Promise<void> => {
      const before = revision;
      const snapshot = await listNodeSshPrompts().catch(() => null);
      if (cancelled || !snapshot) return;
      if (revision !== before) {
        void refresh();
        return;
      }
      setPrompts(snapshot.filter((entry) => entry.state === "open"));
    };
    void portalListenAuthoritative<PromptEvent>(
      NODE_SSH_PROMPT_EVENT,
      ({ payload }) => {
        revision++;
        setPrompts((current) =>
          payload.state === "open"
            ? current.some((entry) => entry.promptId === payload.promptId)
              ? current
              : [...current, payload]
            : current.filter((entry) => entry.promptId !== payload.promptId),
        );
      },
      { onResync: refresh, resyncOnSubscribe: true },
    ).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const respond = (value: string | null) => {
    if (!prompt) return;
    const id = prompt.promptId;
    setPrompts((current) => current.filter((entry) => entry.promptId !== id));
    setAnswer("");
    void answerNodeSshPrompt(id, value).catch((error: unknown) => toast.error(errorText(error)));
  };

  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => (open ? undefined : respond(null))}>
      <DialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            respond(answer);
          }}
          className="space-y-3"
        >
          <DialogHeader>
            <DialogTitle>SSH needs your answer — {prompt?.nodeId}</DialogTitle>
            <DialogDescription>{prompt?.message}</DialogDescription>
          </DialogHeader>
          {prompt?.kind === "confirm" ? null : (
            <Input
              type="password"
              autoComplete="off"
              autoFocus
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              aria-label="SSH answer"
            />
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => respond(null)}>
              Cancel
            </Button>
            <Button type="submit">{prompt?.kind === "confirm" ? "Yes" : "Send"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
