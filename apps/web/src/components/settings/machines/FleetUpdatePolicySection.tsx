import { useEffect, useState } from "react";
import { toast } from "sonner";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import type { FleetUpdatePolicy } from "@orkestrator/protocol/fleet-currency";
import {
  HOST_UPDATE_CHANNELS,
  type HostUpdateChannel,
} from "@orkestrator/protocol/host-maintenance";
import { Switch } from "@/components/ui/switch";
import {
  getFleetUpdatePolicy,
  setFleetUpdatePolicyChannel,
} from "@/lib/portal/fleet-update-policy";
import { cn } from "@/lib/utils";
import { SETTINGS_CARD_CLASS } from "../SettingsPageLayout";
import { errorText } from "./machine-ui";

const CHANNEL_LABELS: Record<HostUpdateChannel, string> = {
  stable: "Stable",
  beta: "Beta",
  unstable: "Unstable",
};

/**
 * The command node's opt-in update policy (plan item 5006): per update
 * channel, whether the machines it controls on that channel are kept on its
 * own version. Off until the user turns a channel on. Hidden when the
 * command node predates the policy.
 */
export function FleetUpdatePolicySection() {
  const [policy, setPolicy] = useState<FleetUpdatePolicy | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState<HostUpdateChannel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getFleetUpdatePolicy().then(
      (value) => active && setPolicy(value),
      (error: unknown) => {
        if (!active) return;
        if (incompatibility(error, "get_fleet_update_policy")) setUnsupported(true);
        else setLoadError(errorText(error));
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (unsupported) return null;

  const change = async (channel: HostUpdateChannel, enabled: boolean) => {
    setBusy(channel);
    try {
      setPolicy(await setFleetUpdatePolicyChannel(channel, enabled));
    } catch (error) {
      toast.error("Could not change the update policy", { description: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className={cn(SETTINGS_CARD_CLASS, "space-y-3 px-4 py-3")}
      data-testid="fleet-update-policy"
      aria-labelledby="fleet-update-policy-title"
    >
      <div>
        <h3 id="fleet-update-policy-title" className="text-sm font-medium text-zinc-200">
          Keep machines on this machine&apos;s version
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
          A machine this one controls that runs an older Orkestrator is asked to install this
          machine&apos;s version once nothing is running there. Only releases its own update channel
          ships, and never a downgrade. Off unless you turn a channel on.
        </p>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {HOST_UPDATE_CHANNELS.map((channel) => {
          const id = `fleet-update-policy-${channel}`;
          return (
            <label key={channel} htmlFor={id} className="flex items-center gap-2 text-sm">
              <Switch
                id={id}
                checked={policy?.channels[channel] ?? false}
                disabled={policy === null || busy !== null}
                onCheckedChange={(checked) => void change(channel, checked)}
                aria-label={`Keep machines on the ${CHANNEL_LABELS[channel]} channel on this version`}
              />
              <span className="text-zinc-300">{CHANNEL_LABELS[channel]}</span>
            </label>
          );
        })}
      </div>
      {loadError ? (
        <p className="text-xs text-red-300" role="alert">
          Could not read the update policy: {loadError}
        </p>
      ) : null}
    </section>
  );
}
