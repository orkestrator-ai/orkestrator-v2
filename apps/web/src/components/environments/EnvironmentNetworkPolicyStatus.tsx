import { useEffect, useState } from "react";
import type { EnvironmentNetworkPolicy } from "@orkestrator/protocol/container-recovery";
import * as backend from "@/lib/backend";

/**
 * What the container's firewall actually applied, next to what is configured.
 * A difference (a stale container, a failed application, the legacy shared
 * network) is stated rather than implied.
 */
export function EnvironmentNetworkPolicyStatus({ environmentId }: { environmentId: string }) {
  const [policy, setPolicy] = useState<EnvironmentNetworkPolicy | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await backend.getEnvironmentNetworkPolicy(environmentId);
        if (!cancelled) setPolicy(next);
      } catch {
        if (!cancelled) setPolicy(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  if (!policy || policy.policyVersion === null) return null;
  const effective = policy.effective;
  return (
    <div
      className="space-y-1 rounded-md border border-zinc-700 p-3 text-xs text-muted-foreground"
      role="status"
    >
      <div className="font-medium text-foreground">Applied in the container</div>
      {!effective ? (
        <div>The container has not reported its firewall state (it may be stopped).</div>
      ) : effective.state === "failed" ? (
        <div className="text-destructive">
          The firewall failed to apply; the container blocks all outbound traffic until it is
          restarted.
        </div>
      ) : effective.mode === "full" ? (
        <div>
          Full access
          {policy.configured.mode === "restricted"
            ? " — restricted is saved and applies when the container is rebuilt."
            : "."}
        </div>
      ) : (
        <div>
          Restricted
          {effective.appliedAt ? ` since ${new Date(effective.appliedAt).toLocaleString()}` : ""}
          {effective.allowedEntries !== null
            ? ` · ${effective.allowedEntries} allowed address ranges`
            : ""}
          {effective.unresolvedDomains
            ? ` · ${effective.unresolvedDomains} domains did not resolve`
            : ""}
          {effective.ipv6 ? ` · IPv6 ${effective.ipv6}` : ""}
          {policy.configured.mode === "full"
            ? " — full access is saved and applies when the container is rebuilt."
            : ""}
        </div>
      )}
      {policy.policyVersion === 1 ? (
        <div>
          This container shares Docker&apos;s default network, and its firewall allows the whole
          host network. Rebuilding gives it its own network with host access limited to Orkestrator.
        </div>
      ) : null}
    </div>
  );
}
