import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EnvironmentNetworkPolicy } from "@orkestrator/protocol/container-recovery";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { EnvironmentNetworkPolicyStatus } from "./EnvironmentNetworkPolicyStatus";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

function install(policy: EnvironmentNetworkPolicy) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string) =>
    command === "get_environment_network_policy" ? policy : undefined,
  );
}

const base: EnvironmentNetworkPolicy = {
  environmentId: "env-net",
  configured: { mode: "restricted", domains: 3, domainsRevision: "aaaaaaaaaaaaaaaa" },
  policyVersion: 2,
  domains: "applied",
  effective: {
    mode: "restricted",
    state: "applied",
    appliedAt: "2026-09-27T00:00:00Z",
    resolvedDomains: 3,
    unresolvedDomains: 1,
    allowedEntries: 40,
    hostServicePorts: "41234",
    ipv6: "blocked",
    githubRanges: "seed",
    domainsRevision: "aaaaaaaaaaaaaaaa",
    refreshedAt: "2026-09-27T00:10:00Z",
    nextRefreshAt: "2026-09-27T00:15:00Z",
    carriedDomains: 0,
    carriedUntil: null,
    refreshFailures: 0,
    revokedEntries: 0,
    revocation: "conntrack",
  },
};

describe("environment network policy status", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("shows what the firewall applied", async () => {
    install(base);
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/40 allowed address ranges/);
    expect(screen.getByText(/1 domains did not resolve/)).toBeTruthy();
    expect(screen.getByText(/IPv6 blocked/)).toBeTruthy();
  });

  test("states a failed application and a legacy shared network", async () => {
    install({
      ...base,
      policyVersion: 1,
      effective: { ...base.effective!, state: "failed" },
    });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/firewall failed to apply/);
    expect(screen.getByText(/shares Docker's default network/)).toBeTruthy();
  });

  test("a saved mode that differs from the applied one awaits a rebuild", async () => {
    install({
      ...base,
      domains: "rebuild-required",
      configured: { mode: "full", domains: 0, domainsRevision: "bbbbbbbbbbbbbbbb" },
    });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/full access is saved and applies when the container is rebuilt/);
  });

  test("reports refresh timing and domains kept from an earlier resolution", async () => {
    install({
      ...base,
      effective: {
        ...base.effective!,
        carriedDomains: 2,
        carriedUntil: "2026-09-27T06:00:00Z",
        refreshFailures: 1,
      },
    });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/saved allowlist is the one this container enforces/);
    expect(screen.getByText(/Addresses resolved/).textContent).toContain("1 failed refreshes");
    expect(
      screen.getByText(/2 domains did not resolve and keep their earlier addresses/),
    ).toBeTruthy();
  });

  test("a pending allowlist can be applied in place", async () => {
    const pending: EnvironmentNetworkPolicy = {
      ...base,
      domains: "pending",
      configured: { ...base.configured, domainsRevision: "bbbbbbbbbbbbbbbb" },
    };
    invokeMock.mockClear();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_environment_network_policy") return pending;
      if (command === "apply_environment_allowed_domains") {
        return {
          kind: "applied",
          policy: {
            ...pending,
            domains: "applied",
            effective: { ...pending.effective!, domainsRevision: "bbbbbbbbbbbbbbbb" },
          },
        };
      }
      return undefined;
    });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    fireEvent.click(await screen.findByRole("button", { name: "Apply now" }));
    await screen.findByText(/saved allowlist is the one this container enforces/);
    expect(
      invokeMock.mock.calls.some((call) => call[0] === "apply_environment_allowed_domains"),
    ).toBe(true);
  });

  test("an image without in-place updates says a rebuild applies the list", async () => {
    install({
      ...base,
      domains: "rebuild-required",
      configured: { ...base.configured, domainsRevision: "bbbbbbbbbbbbbbbb" },
    });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/cannot\s+change it in place/);
    expect(screen.queryAllByRole("button", { name: "Apply now" })).toHaveLength(0);
  });
});
