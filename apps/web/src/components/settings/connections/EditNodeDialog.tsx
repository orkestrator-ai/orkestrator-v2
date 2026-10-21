import { type FormEvent, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { NodeRoute, NodeView } from "@orkestrator/protocol/command-nodes";
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
import { nodeErrorText as errorText, updateNode } from "@/lib/backend/command-nodes";

function routeText(route: NodeRoute): string {
  return route.kind === "https"
    ? `HTTPS ${route.origin}`
    : `SSH ${route.destination}${route.sshPort ? `:${route.sshPort}` : ""} → port ${route.remoteGatewayPort}`;
}

/**
 * A registered node's routes (order, enabled state, add, remove) and its
 * gateway token. The command node verifies every route with the hello
 * before using it; the token is sent to the command node once and never
 * shown again.
 */
export function EditNodeDialog({
  node,
  open,
  onOpenChange,
  onSaved,
}: {
  node: NodeView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const ordered = () =>
    node.routeOrder
      .map((id) => node.routes.find((route) => route.id === id))
      .filter((route): route is NodeRoute => route !== undefined);
  const [routes, setRoutes] = useState<NodeRoute[]>(ordered);
  const [token, setToken] = useState("");
  const [kind, setKind] = useState<"https" | "ssh">("https");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [remotePort, setRemotePort] = useState("34122");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const save = async (event: FormEvent) => {
    event.preventDefault();
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
      toast.success(`Saved ${node.displayName}. Its routes are verified before use.`);
      onSaved();
      onOpenChange(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
        <form onSubmit={(event) => void save(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Routes to {node.displayName}</DialogTitle>
            <DialogDescription>
              Routes are tried in this order. A route that reaches a different machine, or fails a
              host-key or certificate check, is blocked rather than skipped.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-2" data-testid="node-routes">
            {routes.map((route, index) => (
              <li
                key={route.id}
                className="flex items-center gap-2 rounded border border-zinc-800 p-2 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{routeText(route)}</span>
                <Switch
                  checked={route.enabled}
                  aria-label={`Use ${routeText(route)}`}
                  onCheckedChange={(enabled) =>
                    setRoutes(
                      routes.map((entry) =>
                        entry.id === route.id ? { ...entry, enabled } : entry,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={`Move ${routeText(route)} up`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={index === routes.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={`Move ${routeText(route)} down`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={routes.length === 1}
                  onClick={() => setRoutes(routes.filter((entry) => entry.id !== route.id))}
                  aria-label={`Remove ${routeText(route)}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="space-y-2 rounded border border-dashed border-zinc-800 p-2">
            <div className="flex gap-2">
              {(["https", "ssh"] as const).map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={kind === option ? "default" : "outline"}
                  onClick={() => setKind(option)}
                >
                  {option === "https" ? "HTTPS" : "SSH"}
                </Button>
              ))}
            </div>
            {kind === "https" ? (
              <Input
                aria-label="New route address"
                placeholder="https://machine.tailnet.ts.net"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
              />
            ) : (
              <div className="flex gap-2">
                <Input
                  aria-label="New route SSH destination"
                  placeholder="machine"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                />
                <Input
                  aria-label="New route remote gateway port"
                  inputMode="numeric"
                  value={remotePort}
                  onChange={(event) => setRemotePort(event.target.value)}
                />
              </div>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={kind === "https" ? !origin.trim() : !destination.trim()}
              onClick={addRoute}
            >
              Add route
            </Button>
          </div>
          <div className="space-y-1">
            <Label htmlFor="node-new-token">Replace the gateway token (optional)</Label>
            <Input
              id="node-new-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || routes.length === 0}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
