import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";
import { Check, ChevronDown, Eye, EyeOff, Link2, Loader2, RadioTower } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { subscribeToConnections } from "@/lib/connections";

type ConnectionsApi = NonNullable<NonNullable<Window["orkestrator"]>["connections"]>;
type Readiness = "checking" | "ready" | "unavailable";
type DisplayReadiness = Readiness | "needs-token" | "unchecked";

const ACTIVE_PROBE_INTERVAL_MS = 30_000;
const INACTIVE_PROBE_CACHE_MS = 10_000;

function getConnectionsApi(): ConnectionsApi | null {
  return window.orkestrator?.connections ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readinessLabel(readiness: DisplayReadiness): string {
  if (readiness === "needs-token") return "token required";
  if (readiness === "unchecked") return "not checked";
  return readiness;
}

export function ServerConnectionSwitcher() {
  const [connections, setConnections] = useState<ConnectionList | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<Record<string, Readiness>>({});
  const probeGenerations = useRef<Record<string, number>>({});
  const lastProbeAt = useRef<Record<string, number>>({});
  const inFlightProbes = useRef(new Set<string>());
  const skipNextMenuFocus = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const inFlight = inFlightProbes.current;
    const api = getConnectionsApi();
    if (!api) return;
    void api
      .list()
      .then((list) => {
        if (mounted.current) setConnections(list);
      })
      .catch((caught) => {
        toast.error("Could not load saved connections", { description: errorMessage(caught) });
      });
    return () => {
      mounted.current = false;
      inFlight.clear();
    };
  }, []);

  useEffect(() => subscribeToConnections(setConnections), []);

  const probeConnection = useCallback(
    (connection: ConnectionSummary, options: { supersede?: boolean } = {}) => {
      const api = getConnectionsApi();
      if (!api || connection.requiresToken) return;
      if (inFlightProbes.current.has(connection.id) && !options.supersede) return;
      if (
        !options.supersede &&
        Date.now() - (lastProbeAt.current[connection.id] ?? 0) < INACTIVE_PROBE_CACHE_MS
      ) {
        return;
      }

      const generation = (probeGenerations.current[connection.id] ?? 0) + 1;
      probeGenerations.current[connection.id] = generation;
      lastProbeAt.current[connection.id] = Date.now();
      inFlightProbes.current.add(connection.id);
      setReadiness((current) => ({ ...current, [connection.id]: "checking" }));

      void api
        .probe(connection.id)
        .then((ready) => {
          if (!mounted.current || probeGenerations.current[connection.id] !== generation) return;
          setReadiness((current) => ({
            ...current,
            [connection.id]: ready ? "ready" : "unavailable",
          }));
        })
        .catch(() => {
          if (!mounted.current || probeGenerations.current[connection.id] !== generation) return;
          setReadiness((current) => ({ ...current, [connection.id]: "unavailable" }));
        })
        .finally(() => {
          if (probeGenerations.current[connection.id] === generation) {
            inFlightProbes.current.delete(connection.id);
          }
        });
    },
    [],
  );

  const handleMenuOpenChange = (open: boolean) => {
    skipNextMenuFocus.current = open;
    if (!open) return;
    if (connections) {
      const activeConnection = connections.connections.find((connection) => connection.active);
      if (activeConnection) probeConnection(activeConnection, { supersede: true });
      return;
    }
    const api = getConnectionsApi();
    if (!api) return;
    void api
      .list()
      .then((list) => {
        if (!mounted.current) return;
        setConnections(list);
        const activeConnection = list.connections.find((connection) => connection.active);
        if (activeConnection) probeConnection(activeConnection, { supersede: true });
      })
      .catch((caught) => {
        toast.error("Could not load saved connections", { description: errorMessage(caught) });
      });
  };

  const active = useMemo(
    () => connections?.connections.find((connection) => connection.active) ?? null,
    [connections],
  );
  const credentialStorage =
    connections?.credentialStorage ??
    (connections?.connections.some((connection) => connection.kind === "local")
      ? "secure"
      : "session-only");
  const activeReadiness = active ? readiness[active.id] : undefined;

  useEffect(() => {
    if (!active || active.requiresToken) return;
    const refresh = () => probeConnection(active, { supersede: true });
    refresh();
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(refresh, ACTIVE_PROBE_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(interval);
    };
  }, [active, probeConnection]);

  const displayReadiness = (connection: ConnectionSummary): DisplayReadiness =>
    connection.requiresToken ? "needs-token" : (readiness[connection.id] ?? "unchecked");

  const probeFocusedConnection = (connection: ConnectionSummary) => {
    if (skipNextMenuFocus.current) {
      skipNextMenuFocus.current = false;
      return;
    }
    probeConnection(connection);
  };

  const openConnectionDialog = (connection?: ConnectionSummary) => {
    setAddress(connection?.address ?? "");
    setToken("");
    setShowToken(false);
    setError(null);
    setDialogOpen(true);
  };

  const switchConnection = async (connection: ConnectionSummary) => {
    if (connection.active) return;
    if (connection.requiresToken) {
      openConnectionDialog(connection);
      return;
    }
    const api = getConnectionsApi();
    if (!api) return;
    setSwitchingId(connection.id);
    try {
      await api.use(connection.id);
      window.location.reload();
    } catch (caught) {
      toast.error("Could not switch servers", { description: errorMessage(caught) });
      setSwitchingId(null);
    }
  };

  const handleConnect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const api = getConnectionsApi();
    if (!api) return;
    setConnecting(true);
    setError(null);
    try {
      await api.connect({ address, token });
      setToken("");
      window.location.reload();
    } catch (caught) {
      setError(errorMessage(caught));
      setConnecting(false);
    }
  };

  if (!getConnectionsApi()) {
    return <span className="text-sm font-medium text-foreground">Projects</span>;
  }

  return (
    <>
      <DropdownMenu onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-white/[0.045] focus-visible:ring-2 focus-visible:ring-orange-500/60"
            aria-label={`Connected server: ${active?.name ?? "Loading"}`}
          >
            <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-zinc-800 ring-1 ring-white/[0.06]">
              <RadioTower className="h-3 w-3 text-zinc-300" aria-hidden="true" />
              <span
                aria-hidden="true"
                data-status={
                  active?.requiresToken ? "needs-token" : (activeReadiness ?? "unchecked")
                }
                className={`absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full ring-2 ring-[#212124] ${
                  active?.requiresToken
                    ? "bg-amber-400"
                    : activeReadiness === "ready"
                      ? "bg-emerald-400"
                      : activeReadiness === "checking"
                        ? "animate-pulse bg-zinc-500"
                        : "bg-zinc-600"
                }`}
              />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {active?.name ?? "Loading…"}
            </span>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-colors group-hover:text-zinc-300"
              aria-hidden="true"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72" sideOffset={6}>
          <DropdownMenuLabel className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            Servers
          </DropdownMenuLabel>
          {connections?.connections.map((connection) => (
            <DropdownMenuItem
              key={connection.id}
              className="min-h-11 items-start py-2"
              disabled={switchingId !== null}
              onFocus={() => probeFocusedConnection(connection)}
              onPointerMove={() => probeConnection(connection)}
              onSelect={() => void switchConnection(connection)}
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                {switchingId === connection.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : connection.active ? (
                  <Check className="h-3.5 w-3.5 text-zinc-300" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-100">{connection.name}</span>
                {connection.address && (
                  <span className="block truncate text-xs text-zinc-500">
                    {connection.requiresToken ? "Token required · " : ""}
                    {connection.address}
                  </span>
                )}
              </span>
              <span className="sr-only">
                , status: {readinessLabel(displayReadiness(connection))}
              </span>
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center"
                aria-hidden="true"
                data-status={displayReadiness(connection)}
              >
                {displayReadiness(connection) === "checking" ? (
                  <Loader2 className="h-3 w-3 animate-spin text-zinc-500" aria-hidden="true" />
                ) : (
                  <span
                    className={`h-2 w-2 rounded-full ${
                      displayReadiness(connection) === "ready"
                        ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.45)]"
                        : displayReadiness(connection) === "needs-token"
                          ? "bg-amber-400"
                          : "bg-zinc-600"
                    }`}
                    aria-hidden="true"
                  />
                )}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="py-2 text-zinc-100" onSelect={() => openConnectionDialog()}>
            <Link2 className="h-4 w-4 text-orange-400" />
            New connection
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogOpen} onOpenChange={(open) => !connecting && setDialogOpen(open)}>
        <DialogContent className="max-w-md p-0 sm:max-w-md sm:p-0">
          <form onSubmit={handleConnect}>
            <DialogHeader className="m-0 border-b border-divider bg-background px-6 py-5 sm:m-0">
              <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500/10 ring-1 ring-orange-400/20">
                <RadioTower className="h-4 w-4 text-orange-400" aria-hidden="true" />
              </div>
              <DialogTitle>New connection</DialogTitle>
              <DialogDescription>
                Connect directly to an Orkestrator backend on your tailnet.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5 px-6 py-5">
              <div className="space-y-2">
                <Label htmlFor="connection-address">Tailscale address</Label>
                <Input
                  id="connection-address"
                  type="text"
                  inputMode="url"
                  placeholder="workstation or https://workstation.tailnet.ts.net"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  autoComplete="url"
                  disabled={connecting}
                  required
                />
                <p className="text-xs leading-relaxed text-zinc-500">
                  A machine name reuses the tailnet suffix from a saved connection. Use the full
                  HTTPS origin the first time.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="connection-token">Gateway token</Label>
                <div className="relative">
                  <Input
                    id="connection-token"
                    type={showToken ? "text" : "password"}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    autoComplete="current-password"
                    className="pr-10 font-mono text-xs"
                    disabled={connecting}
                    required
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-zinc-500 hover:text-zinc-200"
                    onClick={() => setShowToken((value) => !value)}
                    aria-label={showToken ? "Hide gateway token" : "Show gateway token"}
                    disabled={connecting}
                  >
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-xs leading-relaxed text-zinc-500">
                  {credentialStorage === "secure"
                    ? "Stored with your operating system’s secure credential storage."
                    : "Kept for this app session only. The server address is remembered."}
                </p>
              </div>

              {error && (
                <div
                  className="rounded-md border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-sm text-red-300"
                  role="alert"
                >
                  {error}
                </div>
              )}
            </div>

            <DialogFooter className="m-0 border-t border-divider px-6 py-4 sm:m-0 sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDialogOpen(false)}
                disabled={connecting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="bg-orange-500 text-black hover:bg-orange-400"
                disabled={connecting}
              >
                {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
