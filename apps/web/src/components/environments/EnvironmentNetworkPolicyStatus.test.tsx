import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
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
  configured: { mode: "restricted", domains: 3 },
  policyVersion: 2,
  effective: {
    mode: "restricted",
    state: "applied",
    appliedAt: "2026-09-27T00:00:00Z",
    resolvedDomains: 3,
    unresolvedDomains: 1,
    allowedEntries: 40,
    hostServicePorts: "41234",
    ipv6: "blocked",
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
    install({ ...base, configured: { mode: "full", domains: 0 } });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/full access is saved and applies when the container is rebuilt/);
  });
});
