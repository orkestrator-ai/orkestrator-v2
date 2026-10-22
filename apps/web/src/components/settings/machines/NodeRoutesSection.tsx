import { useState } from "react";
import { ArrowDown, ArrowUp, Globe, Loader2, Plus, Terminal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { NodeRoute, NodeView } from "@orkestrator/protocol/command-nodes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import { Switch } from "@/components/ui/switch";
import { nodeErrorText, updateNode } from "@/lib/backend/command-nodes";
import { FormError, MachineSection, TokenInput } from "./machine-ui";

function routeText(route: NodeRoute): string {
  return route.kind === "https"
    ? route.origin
    : `${route.destination}${route.sshPort ? `:${route.sshPort}` : ""} → port ${route.remoteGatewayPort}`;
}

function orderedRoutes(node: NodeView): NodeRoute[] {
  const ordered = node.routeOrder
    .map((id) => node.routes.find((route) => route.id === id))
    .filter((route): route is NodeRoute => route !== undefined);
  return [...ordered, ...node.routes.filter((route) => !node.routeOrder.includes(route.id))];
}

/**
 * How the command node reaches a registered machine: its addresses (HTTPS
 * or SSH, tried in order) and its gateway token. Every route is verified
 * with the hello before use; the token is sent once and never shown again.
 */
export function NodeRoutesSection({
  node,
  disabled,
  onSaved,
}: {
  node: NodeView;
  disabled?: boolean;
  onSaved: () => void;
}) {
  const [routes, setRoutes] = useState<NodeRoute[]>(() => orderedRoutes(node));
  const [token, setToken] = useState("");
  const [kind, setKind] = useState<"https" | "ssh">("https");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [remotePort, setRemotePort] = useState("34122");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRouteId = node.connection.activeRouteId;

  const dirty =
    token.trim() !== "" || JSON.stringify(routes) !== JSON.stringify(orderedRoutes(node));

  const move = (index: number, by: number) => {
    const next = [...routes];
    const [route] = next.splice(index, 1);
    next.splice(index + by, 0, route!);
    setRoutes(next);
  };

  const addRoute = () => {
    const id = `route-${Date.now().toString(36)}` as NodeRoute["id"];
    const route: NodeRoute =
      kind === "https"
        ? { id, kind: "https", enabled: true, origin: origin.trim().replace(/\/$/, "") }
        : {
            id,
            kind: "ssh",
            enabled: true,
            destination: destination.trim(),
            remoteGatewayPort: Number(remotePort),
          };
    setRoutes([...routes, route]);
    setOrigin("");
    setDestination("");
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateNode({
        nodeId: node.nodeId,
        routes,
        routeOrder: routes.map((route) => route.id),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      setToken("");
      toast.success(`Saved ${node.displayName}`, {
        description: "New addresses are verified before they are used.",
      });
      onSaved();
    } catch (failure) {
      setError(nodeErrorText(failure));
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || disabled === true;
  return (
    <MachineSection
      title="Address and connection"
      description="Addresses are tried in this order. One that reaches a different machine, or fails a host-key or certificate check, is blocked rather than skipped."
      testId="machine-node-routes"
    >
      <ul className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800/70">
        {routes.map((route, index) => (
          <li key={route.id} className="flex items-center gap-2 px-2.5 py-2 text-xs">
            {route.kind === "ssh" ? (
              <Terminal className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
            ) : (
              <Globe className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">
              {routeText(route)}
            </span>
            {route.id === activeRouteId ? (
              <span className="text-[11px] text-emerald-300">In use</span>
            ) : null}
            <Switch
              checked={route.enabled}
              disabled={busy}
              aria-label={`Use ${routeText(route)}`}
              onCheckedChange={(enabled) =>
                setRoutes(
                  routes.map((entry) => (entry.id === route.id ? { ...entry, enabled } : entry)),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
              aria-label={`Move ${routeText(route)} up`}
            >
              <ArrowUp className="h-3 w-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={busy || index === routes.length - 1}
              onClick={() => move(index, 1)}
              aria-label={`Move ${routeText(route)} down`}
            >
              <ArrowDown className="h-3 w-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-zinc-500 hover:text-red-300"
              disabled={busy || routes.length === 1}
              onClick={() => setRoutes(routes.filter((entry) => entry.id !== route.id))}
              aria-label={`Remove ${routeText(route)}`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </li>
        ))}
      </ul>

      <div className="space-y-2 rounded-md border border-dashed border-zinc-800 p-2.5">
        <SegmentedSelector
          ariaLabel="New address type"
          value={kind}
          onValueChange={setKind}
          disabled={busy}
          options={[
            { value: "https", label: "Tailscale / HTTPS" },
            { value: "ssh", label: "SSH" },
          ]}
        />
        <div className="flex gap-2">
          {kind === "https" ? (
            <Input
              aria-label="New HTTPS address"
              placeholder="https://machine.tailnet.ts.net"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              disabled={busy}
              className="h-8"
            />
          ) : (
            <>
              <Input
                aria-label="New SSH destination"
                placeholder="machine or user@machine"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                disabled={busy}
                className="h-8"
              />
              <Input
                aria-label="Orkestrator port on that machine"
                inputMode="numeric"
                value={remotePort}
                onChange={(event) => setRemotePort(event.target.value)}
                disabled={busy}
                className="h-8 w-24"
              />
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 gap-1"
            disabled={busy || (kind === "https" ? !origin.trim() : !destination.trim())}
            onClick={addRoute}
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`node-token-${node.nodeId}`}>Connection token</Label>
        <TokenInput
          id={`node-token-${node.nodeId}`}
          value={token}
          onChange={setToken}
          disabled={busy}
          placeholder={node.hasCredential ? "Saved — enter a new one to replace it" : "Required"}
        />
      </div>

      {error ? <FormError message={error} /> : null}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          disabled={busy || !dirty || routes.length === 0}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save connection
        </Button>
      </div>
    </MachineSection>
  );
}
