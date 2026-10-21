import { useState } from "react";
import { toast } from "sonner";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { Switch } from "@/components/ui/switch";
import { publishConnections } from "@/lib/connections";
import { useMachineViewStore } from "@/stores/machineViewStore";

/**
 * This device's route features for the machines it can connect to directly
 * (its targets). Multi-machine views come from the connected command node,
 * not from this client. Turning one off never stops work on any machine.
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
