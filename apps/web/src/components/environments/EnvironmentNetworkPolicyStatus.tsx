import { useEffect, useState } from "react";
import type { EnvironmentNetworkPolicy } from "@orkestrator/protocol/container-recovery";
import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";

const APPLY_OUTCOME: Record<string, string> = {
  "not-running": "The container is not running; the list is applied when it starts.",
  "rebuild-required": "This container cannot change its allowlist in place; rebuild it to apply.",
  failed: "The container kept its previous allowlist. Try again, or rebuild the container.",
  "not-applicable": "This environment has no container to apply the list to.",
};

function DomainsState({
  policy,
  onApply,
  applying,
  outcome,
}: {
  policy: EnvironmentNetworkPolicy;
  onApply: () => void;
  applying: boolean;
  outcome: string | null;
}) {
  const effective = policy.effective;
  if (policy.configured.mode !== "restricted" || !effective || effective.mode !== "restricted") {
    return null;
  }
  return (
    <>
      {policy.domains === "applied" ? (
        <div>The saved allowlist is the one this container enforces.</div>
      ) : policy.domains === "pending" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>The saved allowlist differs from the one this container enforces.</span>
          <Button size="sm" variant="outline" onClick={onApply} disabled={applying}>
            {applying ? "Applying…" : "Apply now"}
          </Button>
        </div>
      ) : policy.domains === "rebuild-required" ? (
        <div>
          The saved allowlist differs from the one this container enforces, and its image cannot
          change it in place. It applies when the container is rebuilt.
        </div>
      ) : null}
      {effective.refreshedAt ? (
        <div>
          Addresses resolved {new Date(effective.refreshedAt).toLocaleString()}
          {effective.nextRefreshAt
            ? ` · next refresh ${new Date(effective.nextRefreshAt).toLocaleTimeString()}`
            : ""}
          {effective.refreshFailures ? ` · ${effective.refreshFailures} failed refreshes` : ""}
        </div>
      ) : null}
      {effective.carriedDomains ? (
        <div>
          {effective.carriedDomains} domains did not resolve and keep their earlier addresses
          {effective.carriedUntil
            ? ` until ${new Date(effective.carriedUntil).toLocaleString()}`
            : ""}
          .
        </div>
      ) : null}
      {effective.revocation === "unavailable" && effective.revokedEntries ? (
        <div>
          Removed addresses no longer accept new connections, but connections already open to them
          were not closed.
        </div>
      ) : null}
      {outcome ? <div role="alert">{outcome}</div> : null}
    </>
  );
}

/**
 * What the container's firewall actually applied, next to what is configured.
 * A difference (a stale container, a failed application, the legacy shared
 * network) is stated rather than implied.
 */
export function EnvironmentNetworkPolicyStatus({ environmentId }: { environmentId: string }) {
  const [policy, setPolicy] = useState<EnvironmentNetworkPolicy | null>(null);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const apply = async () => {
    setApplying(true);
    setOutcome(null);
    try {
      const result = await backend.applyEnvironmentAllowedDomains(environmentId);
      setPolicy(result.policy);
      setOutcome(APPLY_OUTCOME[result.kind] ?? null);
    } catch {
      setOutcome(APPLY_OUTCOME.failed ?? null);
    } finally {
      setApplying(false);
    }
  };

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
      <DomainsState
        policy={policy}
        onApply={() => void apply()}
        applying={applying}
        outcome={outcome}
      />
      {policy.policyVersion === 1 ? (
        <div>
          This container shares Docker&apos;s default network, and its firewall allows the whole
          host network. Rebuilding gives it its own network with host access limited to Orkestrator.
        </div>
      ) : null}
    </div>
  );
}
