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
    expect(screen.getByText(/reachable on\s+every port/)).toBeTruthy();
  });

  test("says where the firewall is enforced and whether a root terminal can change it", async () => {
    install({ ...base, enforcement: "gateway" });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/Enforced by the environment's egress gateway/);
    expect(screen.queryByText(/a root terminal can change these rules/) === null).toBe(true);
    cleanup();
    install({ ...base, enforcement: "container" });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/Enforced inside the container, so a root terminal can change/);
    cleanup();
    // A backend that predates the report says nothing about it.
    install(base);
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/40 allowed address ranges/);
    expect(screen.queryByText(/Enforced/) === null).toBe(true);
  });

  test("policy 3 states that allowed domains answer on HTTPS and the ports entries name", async () => {
    install({ ...base, policyVersion: 3 });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/HTTPS \(port 443\) and on the ports their entries name/);
    expect(screen.getByText(/40 allowed address and port rules/)).toBeTruthy();
    expect(screen.queryByText(/allowed address ranges/) === null).toBe(true);
    expect(screen.queryByText(/every port/) === null).toBe(true);
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
  test("shows how many connections and queries the name checks refused, never which names", async () => {
    const effective = base.effective!;
    const show = async (refusals: { connections: number; queries: number }) => {
      cleanup();
      install({
        ...base,
        policyVersion: 3,
        enforcement: "gateway",
        effective: { ...effective, egressFilter: "enforced", refusals },
      });
      render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
      await screen.findByText(/Names are checked too/);
    };
    await show({ connections: 3, queries: 2 });
    expect(
      screen.getByText(/name checks have refused 3 connections and 2 DNS queries/),
    ).toBeTruthy();
    expect(screen.getByText(/does not record which names/)).toBeTruthy();
    await show({ connections: 1, queries: 1 });
    expect(screen.getByText(/refused 1 connection and 1 DNS query\./)).toBeTruthy();
    await show({ connections: 0, queries: 0 });
    expect(screen.getByText(/name checks have refused nothing/)).toBeTruthy();
  });

  test("says whether the gateway also checks names, and what it cannot see", async () => {
    const effective = base.effective!;
    install({
      ...base,
      policyVersion: 3,
      enforcement: "gateway",
      effective: { ...effective, egressFilter: "enforced" },
    });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/Names are checked too/);
    expect(screen.getByText(/hidden inside encrypted traffic/)).toBeTruthy();
    // A gateway from before the counts: nothing said about refusals.
    expect(screen.queryByText(/name checks have refused/) === null).toBe(true);
    cleanup();
    install({
      ...base,
      policyVersion: 3,
      enforcement: "gateway",
      effective: { ...effective, egressFilter: "off" },
    });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/Name checks were switched off/);
    cleanup();
    install({
      ...base,
      policyVersion: 2,
      enforcement: "gateway",
      effective: { ...effective, egressFilter: "unavailable" },
    });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/Name checks require network policy 3/);
    expect(screen.getByText(/network policy 2 override is removed/)).toBeTruthy();
    expect(screen.queryByText(/image predates name checks/) === null).toBe(true);
    cleanup();
    // An older image's gateway reports no such field: addresses only.
    install({
      ...base,
      policyVersion: 3,
      enforcement: "gateway",
      effective: { ...effective, egressFilter: null },
    });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/image predates name checks/);
    cleanup();
    // A backend that predates the field says nothing about name checks.
    install({ ...base, policyVersion: 3, enforcement: "gateway" });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/Enforced by the environment's egress gateway/);
    expect(screen.queryByText(/name checks/i) === null).toBe(true);
    cleanup();
    // An in-container firewall never had them; nothing is claimed either way.
    install({ ...base, enforcement: "container" });
    render(<EnvironmentNetworkPolicyStatus environmentId="env-net" />);
    await screen.findByText(/Enforced inside the container/);
    expect(screen.queryByText(/name checks/i) === null).toBe(true);
    expect(screen.queryByText(/Names are checked/) === null).toBe(true);
  });

  describe("refusal counts while the section stays open", () => {
    const counted = (connections: number, queries: number): EnvironmentNetworkPolicy => ({
      ...base,
      policyVersion: 3,
      enforcement: "gateway",
      effective: {
        ...base.effective!,
        egressFilter: "enforced",
        refusals: { connections, queries },
      },
    });
    const reads = () =>
      invokeMock.mock.calls.filter((call) => call[0] === "get_environment_network_policy").length;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    afterEach(() => {
      delete (document as unknown as { visibilityState?: string }).visibilityState;
    });

    test("re-reads the policy on an interval and shows the new counts", async () => {
      install(counted(1, 0));
      render(<EnvironmentNetworkPolicyStatus environmentId="env-net" refreshIntervalMs={20} />);
      await screen.findByText(/refused 1 connection and 0 DNS queries/);
      install(counted(4, 2));
      await screen.findByText(/refused 4 connections and 2 DNS queries/);
      expect(reads()).toBeGreaterThan(0);
    });

    test("does not read while the window is hidden, and reads once it is visible again", async () => {
      install(counted(1, 0));
      render(<EnvironmentNetworkPolicyStatus environmentId="env-net" refreshIntervalMs={20} />);
      await screen.findByText(/refused 1 connection/);
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      install(counted(5, 5));
      await wait(120);
      expect(reads()).toBe(0);
      expect(screen.getByText(/refused 1 connection and 0 DNS queries/)).toBeTruthy();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await screen.findByText(/refused 5 connections and 5 DNS queries/);
    });

    test("keeps the last counts when a refresh fails", async () => {
      install(counted(2, 1));
      render(<EnvironmentNetworkPolicyStatus environmentId="env-net" refreshIntervalMs={20} />);
      await screen.findByText(/refused 2 connections and 1 DNS query\./);
      invokeMock.mockClear();
      invokeMock.mockImplementation(async () => {
        throw new Error("gateway unreachable");
      });
      await wait(120);
      expect(reads()).toBeGreaterThan(0);
      expect(screen.getByText(/refused 2 connections and 1 DNS query\./)).toBeTruthy();
    });

    test("polls only while counts are shown, and stops when the section closes", async () => {
      // A gateway without the counts (or without name checks) is read once.
      install({
        ...base,
        policyVersion: 3,
        enforcement: "gateway",
        effective: { ...base.effective!, egressFilter: null },
      });
      render(<EnvironmentNetworkPolicyStatus environmentId="env-net" refreshIntervalMs={20} />);
      await screen.findByText(/image predates name checks/);
      await wait(120);
      expect(reads()).toBe(1);
      cleanup();

      install(counted(1, 1));
      const view = render(
        <EnvironmentNetworkPolicyStatus environmentId="env-net" refreshIntervalMs={20} />,
      );
      await screen.findByText(/refused 1 connection and 1 DNS query/);
      view.unmount();
      invokeMock.mockClear();
      await wait(120);
      expect(reads()).toBe(0);
    });

    test("an apply's result is not overwritten by a refresh that was in flight", async () => {
      const pending: EnvironmentNetworkPolicy = {
        ...counted(1, 0),
        domains: "pending",
        configured: { ...base.configured, domainsRevision: "bbbbbbbbbbbbbbbb" },
      };
      let releaseRead: (() => void) | null = null;
      let first = true;
      invokeMock.mockClear();
      invokeMock.mockImplementation(async (command: string) => {
        if (command === "get_environment_network_policy") {
          if (first) {
            first = false;
            return pending;
          }
          // A slow refresh that answers with the state from before the apply.
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
          return pending;
        }
        if (command === "apply_environment_allowed_domains") {
          return {
            kind: "applied",
            policy: { ...pending, domains: "applied" },
          };
        }
        return undefined;
      });
      render(<EnvironmentNetworkPolicyStatus environmentId="env-net" refreshIntervalMs={20} />);
      const button = await screen.findByRole("button", { name: "Apply now" });
      await wait(60);
      expect(releaseRead).not.toBeNull();
      fireEvent.click(button);
      await screen.findByText(/saved allowlist is the one this container enforces/);
      releaseRead!();
      await wait(20);
      expect(screen.getByText(/saved allowlist is the one this container enforces/)).toBeTruthy();
    });
  });
});
