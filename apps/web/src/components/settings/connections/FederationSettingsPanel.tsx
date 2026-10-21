import { useState, type FormEvent } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MachineDot, machineStatusText } from "@/components/federation/MachineDot";
import { machineDisplayName, useFederation } from "@/components/federation/FederationProvider";
import { addBrowserMachine, removeBrowserMachine } from "@/lib/federation/browser-machines";
import { publishConnections } from "@/lib/connections";
import { useMachineViewStore } from "@/stores/machineViewStore";

/**
 * Client feature flags. Turning one off stops this client's own machinery
 * (observation, tunnels, fallback); it never stops work on any machine.
 */
export function FederationFeatureToggles({ list }: { list: ConnectionList }) {
  const api = window.orkestrator?.connections;
  const compact = useMachineViewStore((state) => state.compactMachineLabels);
  const setCompact = useMachineViewStore((state) => state.setCompactMachineLabels);
  const [busy, setBusy] = useState<string | null>(null);
  if (!api?.setFeatures || !list.features) return null;
  const features = list.features;
  const toggle = async (key: "federation" | "sshRoutes" | "routeFallback", value: boolean) => {
    setBusy(key);
    try {
      publishConnections(await api.setFeatures!({ [key]: value }));
    } catch (error) {
      toast.error("Could not change the setting", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };
  const rows: Array<{
    key: "federation" | "sshRoutes" | "routeFallback";
    label: string;
    help: string;
  }> = [
    {
      key: "federation",
      label: "Show all machines together",
      help: "One sidebar for every saved machine, plus side-by-side machine panels.",
    },
    {
      key: "sshRoutes",
      label: "Managed SSH routes",
      help: "Reach a machine's backend through your system OpenSSH (desktop only).",
    },
    {
      key: "routeFallback",
      label: "Automatic route fallback",
      help: "When a route drops, try the machine's next approved route. Trust failures never fall back.",
    },
  ];
  return (
    <div
      className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4"
      data-testid="federation-toggles"
    >
      <p className="text-sm font-medium text-zinc-200">This client</p>
      {rows.map((row) => (
        <div key={row.key} className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-200">{row.label}</p>
            <p className="text-xs text-zinc-500">{row.help}</p>
          </div>
          <Switch
            checked={features[row.key]}
            disabled={
              busy !== null ||
              (row.key === "sshRoutes" &&
                !list.supportedRouteKinds?.includes("ssh") &&
                !features.sshRoutes)
            }
            aria-label={row.label}
            onCheckedChange={(value) => void toggle(row.key, value)}
          />
        </div>
      ))}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-200">Compact machine labels</p>
          <p className="text-xs text-zinc-500">
            Show only the machine dot in mixed lists; the name stays in tooltips.
          </p>
        </div>
        <Switch
          checked={compact}
          aria-label="Compact machine labels"
          onCheckedChange={setCompact}
        />
      </div>
    </div>
  );
}

/**
 * Hosted browser: other machines this tab talks to directly over HTTPS.
 * Each machine must allow this page's origin. Tokens stay in this tab only.
 */
export function BrowserMachinesSettings() {
  const { list } = useFederation();
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const machines = list?.connections.filter((connection) => !connection.active) ?? [];
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addBrowserMachine({ address, token, ...(nickname ? { nickname } : {}) });
      setAddress("");
      setToken("");
      setNickname("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-3xl space-y-4" data-testid="browser-machines">
      <div>
        <h3 className="text-base font-semibold text-foreground">Other machines</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Add another Orkestrator machine by its HTTPS address. This page connects to it directly;
          that machine must allow <span className="font-mono">{window.location.origin}</span> in its
          allowed origins. Tokens are kept only in this browser tab. SSH routes need the desktop
          app.
        </p>
      </div>
      <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
        {machines.length === 0 ? (
          <li className="px-4 py-3 text-sm text-muted-foreground">No other machines yet.</li>
        ) : (
          machines.map((machine) => (
            <li key={machine.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <MachineDot
                colorToken={machine.profile?.colorToken}
                machineName={machineDisplayName(machine)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-zinc-100">{machineDisplayName(machine)}</span>
                <span className="block truncate font-mono text-xs text-zinc-500">
                  {machine.address}
                </span>
              </span>
              <span className="text-xs text-zinc-500">
                {machineStatusText({ transport: machine.transport ?? "connecting" })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Forget ${machineDisplayName(machine)} in this browser`}
                onClick={() => removeBrowserMachine(machine.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))
        )}
      </ul>
      <form onSubmit={add} className="grid gap-3 rounded-lg border border-zinc-800 p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="browser-machine-address">HTTPS address</Label>
          <Input
            id="browser-machine-address"
            placeholder="https://build.tailnet.ts.net"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            disabled={busy}
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="browser-machine-token">Gateway token</Label>
          <Input
            id="browser-machine-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            disabled={busy}
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="browser-machine-nickname">Nickname (optional)</Label>
          <Input
            id="browser-machine-nickname"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            maxLength={64}
            disabled={busy}
          />
        </div>
        {error ? (
          <p className="text-sm text-red-300" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="w-fit gap-2" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add machine
        </Button>
      </form>
    </div>
  );
}
