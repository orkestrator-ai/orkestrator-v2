import { useEffect, useRef, useState } from "react";
import type { EnvironmentNetworkPolicy } from "@orkestrator/protocol/container-recovery";
import { Button } from "@/components/ui/button";
import { useScopeBackend } from "@/hooks/useScopeBackend";

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
      {policy.policyVersion === 3 ? (
        <div>
          Allowed domains are reachable on HTTPS (port 443) and on the ports their entries name;
          GitHub also on SSH.
        </div>
      ) : (
        <div>
          This container&apos;s firewall predates per-port rules: an allowed domain is reachable on
          every port.
        </div>
      )}
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

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/**
 * How many connections and DNS queries the name checks refused since the
 * gateway started. Counts only: the gateway keeps no refused name, because
 * one can carry the data an agent tried to send.
 */
function Refusals({
  refusals,
}: {
  refusals: { connections: number; queries: number } | null | undefined;
}) {
  if (!refusals) return null;
  const { connections, queries } = refusals;
  if (connections === 0 && queries === 0) {
    return <div>Since the gateway started, its name checks have refused nothing.</div>;
  }
  return (
    <div>
      Since the gateway started, its name checks have refused{" "}
      {plural(connections, "connection", "connections")} and{" "}
      {plural(queries, "DNS query", "DNS queries")}. It does not record which names, because one
      could carry data an agent tried to send; the agent&apos;s own error names the host.
    </div>
  );
}

/**
 * Whether the gateway also checks names (TLS SNI, HTTP Host, DNS), and what
 * that still leaves open. Absent from a report means an image that predates
 * the checks.
 */
function NameChecks({ policy }: { policy: EnvironmentNetworkPolicy }) {
  const effective = policy.effective;
  if (!effective || effective.mode !== "restricted" || effective.state !== "applied") return null;
  if (effective.egressFilter === "enforced") {
    return (
      <>
        <div>
          Names are checked too: HTTPS and HTTP must ask for an allowed name, and DNS answers only
          allowed names. A name hidden inside encrypted traffic, UDP, and other protocols are
          checked by address only.
        </div>
        <Refusals refusals={effective.refusals} />
      </>
    );
  }
  if (effective.egressFilter === "off") {
    return (
      <div>
        Name checks were switched off when this container was created: any site sharing an allowed
        address is reachable, and any name resolves.
      </div>
    );
  }
  if (effective.egressFilter === "unavailable" && policy.enforcement === "gateway") {
    return (
      <div>
        Name checks require network policy 3. This gateway uses address-only enforcement; rebuilding
        with a current image adds name checks only when the network policy 2 override is removed.
      </div>
    );
  }
  // A backend that predates the field omits it; say nothing rather than
  // guess. `null` is a report without it: an image from before the checks.
  if (effective.egressFilter === undefined || policy.enforcement !== "gateway") return null;
  return (
    <div>
      This container&apos;s image predates name checks: any site sharing an allowed address is
      reachable, and any name resolves. Rebuilding it with a current image adds them.
    </div>
  );
}

/**
 * How often the section re-reads the policy while it shows refusal counts.
 * Each read is one `docker exec` in the gateway, and the daemon rewrites its
 * counts at most once a second, so a slow interval is enough.
 */
export const REFUSAL_COUNTS_REFRESH_MS = 15_000;

/**
 * What the container's firewall actually applied, next to what is configured.
 * A difference (a stale container, a failed application, the legacy shared
 * network) is stated rather than implied.
 */
export function EnvironmentNetworkPolicyStatus({
  environmentId,
  refreshIntervalMs = REFUSAL_COUNTS_REFRESH_MS,
}: {
  environmentId: string;
  /** Tests shorten it; the section uses the default. */
  refreshIntervalMs?: number;
}) {
  const nodeBackend = useScopeBackend();
  const [policy, setPolicy] = useState<EnvironmentNetworkPolicy | null>(null);
  const [applying, setApplying] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  // Every read or apply takes the next number; only the latest may set the
  // policy, so a refresh that was in flight cannot undo an apply's result.
  const generation = useRef(0);
  const applyingNow = useRef(false);

  const apply = async () => {
    setApplying(true);
    setOutcome(null);
    applyingNow.current = true;
    const current = ++generation.current;
    try {
      const result = await nodeBackend.applyEnvironmentAllowedDomains(environmentId);
      if (generation.current === current) setPolicy(result.policy);
      setOutcome(APPLY_OUTCOME[result.kind] ?? null);
    } catch {
      setOutcome(APPLY_OUTCOME.failed ?? null);
    } finally {
      applyingNow.current = false;
      setApplying(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await nodeBackend.getEnvironmentNetworkPolicy(environmentId);
        if (!cancelled) setPolicy(next);
      } catch {
        if (!cancelled) setPolicy(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [environmentId, nodeBackend]);

  // The refusal counts change while the section is open (an agent failing on
  // a host off the list), and nothing pushes them. Re-read the policy on a
  // slow interval while the counts are shown and the window is visible, and
  // once when it becomes visible again. Unmounting stops it.
  const showsRefusals =
    policy?.effective?.egressFilter === "enforced" && Boolean(policy.effective.refusals);
  useEffect(() => {
    if (!showsRefusals) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || applyingNow.current || document.visibilityState === "hidden") return;
      inFlight = true;
      const current = ++generation.current;
      try {
        const next = await nodeBackend.getEnvironmentNetworkPolicy(environmentId);
        if (!cancelled && generation.current === current) setPolicy(next);
      } catch {
        // Keep the last answer: one failed read is not a reason to hide the
        // section, and the next interval tries again.
      } finally {
        inFlight = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(() => void refresh(), refreshIntervalMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [showsRefusals, environmentId, nodeBackend, refreshIntervalMs]);

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
            ? ` · ${effective.allowedEntries} ${policy.policyVersion === 3 ? "allowed address and port rules" : "allowed address ranges"}`
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
      {effective?.mode === "restricted" && policy.enforcement === "gateway" ? (
        <div>
          Enforced by the environment&apos;s egress gateway, outside the container: nothing in it, a
          root terminal included, can change these rules.
        </div>
      ) : effective?.mode === "restricted" && policy.enforcement === "container" ? (
        <div>Enforced inside the container, so a root terminal can change these rules.</div>
      ) : null}
      <NameChecks policy={policy} />
      {policy.network ? (
        <div>
          Network {policy.network.name}
          {policy.network.subnet ? ` · ${policy.network.subnet}` : ""}
          {policy.network.gateway ? ` · gateway ${policy.network.gateway}` : ""}
        </div>
      ) : null}
      {policy.policyVersion === 1 ? (
        <div>
          This container shares Docker&apos;s default network, and its firewall allows the whole
          host network. Rebuilding gives it its own network with host access limited to Orkestrator.
        </div>
      ) : null}
    </div>
  );
}
