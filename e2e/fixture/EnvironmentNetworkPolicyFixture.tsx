import { useState } from "react";
import type { EnvironmentNetworkPolicy } from "@orkestrator/protocol/container-recovery";
import { EnvironmentNetworkPolicyStatus } from "../../apps/web/src/components/environments/EnvironmentNetworkPolicyStatus";

function installBackend() {
  const state = new URLSearchParams(location.search).get("state") ?? "unavailable";
  const egressFilter =
    state === "old"
      ? null
      : state === "off"
        ? "off"
        : state === "enforced"
          ? "enforced"
          : "unavailable";
  const policy: EnvironmentNetworkPolicy = {
    environmentId: "network-policy-fixture",
    configured: { mode: "restricted", domains: 3, domainsRevision: "aaaaaaaaaaaaaaaa" },
    policyVersion: state === "unavailable" ? 2 : 3,
    enforcement: "gateway",
    domains: "applied",
    effective: {
      mode: "restricted",
      state: state === "failed" ? "failed" : "applied",
      appliedAt: null,
      allowedEntries: 40,
      resolvedDomains: 3,
      unresolvedDomains: 0,
      hostServicePorts: null,
      ipv6: "blocked",
      githubRanges: "seed",
      domainsRevision: "aaaaaaaaaaaaaaaa",
      refreshedAt: null,
      nextRefreshAt: null,
      carriedDomains: 0,
      carriedUntil: null,
      refreshFailures: 0,
      revokedEntries: 0,
      revocation: "conntrack",
      egressFilter,
    },
  };
  window.orkestrator = {
    ...window.orkestrator!,
    invoke: async <T,>(command: string): Promise<T> => {
      if (command !== "get_environment_network_policy")
        throw new Error(`Unexpected command: ${command}`);
      if (state === "error") throw new Error("Fixture unavailable");
      return { ...policy, effective: state === "missing" ? null : policy.effective } as T;
    },
  };
  return true;
}

export function EnvironmentNetworkPolicyFixture() {
  useState(installBackend);
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4 text-foreground">
      <h1 className="text-lg font-semibold">Container network policy</h1>
      <EnvironmentNetworkPolicyStatus environmentId="network-policy-fixture" />
    </main>
  );
}
