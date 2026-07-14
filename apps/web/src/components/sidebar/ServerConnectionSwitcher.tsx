import { type FormEvent, useEffect, useMemo, useState } from "react";
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

type ConnectionsApi = NonNullable<NonNullable<Window["orkestrator"]>["connections"]>;

function getConnectionsApi(): ConnectionsApi | null {
  return window.orkestrator?.connections ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  useEffect(() => {
    const api = getConnectionsApi();
    if (!api) return;
    void api.list().then(setConnections).catch((caught) => {
      toast.error("Could not load saved connections", { description: errorMessage(caught) });
    });
  }, []);

  const active = useMemo(
    () => connections?.connections.find((connection) => connection.active) ?? null,
    [connections],
  );
  const credentialStorage = connections?.credentialStorage
    ?? (connections?.connections.some((connection) => connection.kind === "local") ? "secure" : "session-only");

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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-white/[0.045] focus-visible:ring-2 focus-visible:ring-orange-500/60"
            aria-label={`Connected server: ${active?.name ?? "Loading"}`}
          >
            <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-zinc-800 ring-1 ring-white/[0.06]">
              <RadioTower className="h-3 w-3 text-zinc-300" aria-hidden="true" />
              <span className="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400 ring-2 ring-[#212124]" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {active?.name ?? "Loading…"}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-colors group-hover:text-zinc-300" aria-hidden="true" />
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
              onSelect={() => void switchConnection(connection)}
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                {switchingId === connection.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : connection.active ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-100">{connection.name}</span>
                {connection.address && (
                  <span className="block truncate text-xs text-zinc-500">
                    {connection.requiresToken ? "Token required · " : ""}{connection.address}
                  </span>
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
        <DialogContent className="max-w-md border-zinc-800 bg-[#171719] p-0 sm:max-w-md [&_input]:bg-[#101012]">
          <form onSubmit={handleConnect}>
            <DialogHeader className="border-b border-zinc-800/90 px-6 py-5">
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
                  type="url"
                  inputMode="url"
                  placeholder="https://workstation.tailnet.ts.net"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  autoComplete="url"
                  disabled={connecting}
                  required
                />
                <p className="text-xs leading-relaxed text-zinc-500">Use the HTTPS origin, without a path.</p>
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
                <div className="rounded-md border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-sm text-red-300" role="alert">
                  {error}
                </div>
              )}
            </div>

            <DialogFooter className="border-t border-zinc-800/90 px-6 py-4 sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)} disabled={connecting}>
                Cancel
              </Button>
              <Button type="submit" className="bg-orange-500 text-black hover:bg-orange-400" disabled={connecting}>
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
