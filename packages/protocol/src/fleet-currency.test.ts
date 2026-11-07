import { describe, expect, test } from "bun:test";
import {
  compareReleaseVersions,
  DEFAULT_FLEET_UPDATE_POLICY,
  fleetUpdateDecision,
  fleetUpdatePolicyEnabled,
  machineCurrency,
  parseFleetUpdatePolicy,
  type FleetUpdatePolicy,
} from "./fleet-currency.js";
import type { HostMaintenanceSnapshot } from "./host-maintenance.js";

const COMMAND = {
  version: "2.40.0",
  domains: { git: { min: 1, max: 2 }, terminals: { min: 1, max: 1 }, nodes: { min: 2, max: 3 } },
};

describe("compareReleaseVersions", () => {
  test("orders releases and prereleases, and refuses to guess", () => {
    expect(compareReleaseVersions("2.38.0", "2.40.0")).toBe(-1);
    expect(compareReleaseVersions("2.40.1", "2.40.0")).toBe(1);
    expect(compareReleaseVersions("2.40.0-beta.1", "2.40.0")).toBe(-1);
    expect(compareReleaseVersions("2.40.0-beta.2", "2.40.0-beta.10")).toBe(-1);
    expect(compareReleaseVersions("v2.40.0", "2.40.0")).toBe(0);
    expect(compareReleaseVersions("dev", "2.40.0")).toBeNull();
  });
});

describe("machineCurrency", () => {
  test("nothing to show for the same version or an unknown one", () => {
    expect(machineCurrency({ version: "2.40.0", domains: {} }, COMMAND)).toBeNull();
    expect(machineCurrency({ version: null, domains: null }, COMMAND)).toBeNull();
    expect(
      machineCurrency({ version: "2.38.0", domains: {} }, { version: null, domains: null }),
    ).toBeNull();
  });

  test("an older node lists the command node's domains it lacks or cannot negotiate", () => {
    const currency = machineCurrency(
      { version: "2.38.0", domains: { git: { min: 1, max: 1 }, nodes: { min: 1, max: 1 } } },
      COMMAND,
    );
    expect(currency).toEqual({
      version: "2.38.0",
      commandVersion: "2.40.0",
      relation: "older",
      preContract: false,
      // git 1-1 overlaps 1-2; nodes 1-1 does not reach 2-3; terminals is absent.
      lacks: ["nodes", "terminals"],
    });
  });

  test("a pre-contract node lacks every domain", () => {
    expect(machineCurrency({ version: "2.30.0", domains: null }, COMMAND)).toMatchObject({
      relation: "older",
      preContract: true,
      lacks: ["git", "nodes", "terminals"],
    });
  });

  test("a newer node and a non-release version", () => {
    expect(machineCurrency({ version: "2.41.0", domains: COMMAND.domains }, COMMAND)).toMatchObject(
      { relation: "newer", lacks: [] },
    );
    expect(machineCurrency({ version: "dev", domains: COMMAND.domains }, COMMAND)).toMatchObject({
      relation: "different",
    });
  });

  test("a domain named like an Object prototype key is never read from the prototype", () => {
    const command = { version: "2.40.0", domains: { constructor: { min: 1, max: 1 } } };
    expect(machineCurrency({ version: "2.38.0", domains: {} }, command)?.lacks).toEqual([
      "constructor",
    ]);
  });
});

describe("the update policy", () => {
  test("defaults to off for every channel (opt-in)", () => {
    expect(DEFAULT_FLEET_UPDATE_POLICY.channels).toEqual({
      stable: false,
      beta: false,
      unstable: false,
    });
    expect(fleetUpdatePolicyEnabled(DEFAULT_FLEET_UPDATE_POLICY)).toBe(false);
    expect(parseFleetUpdatePolicy(null)).toEqual(DEFAULT_FLEET_UPDATE_POLICY);
    expect(parseFleetUpdatePolicy({ version: 2, channels: { stable: true } })).toEqual(
      DEFAULT_FLEET_UPDATE_POLICY,
    );
    expect(parseFleetUpdatePolicy({ version: 1, channels: { stable: "yes" } })).toEqual(
      DEFAULT_FLEET_UPDATE_POLICY,
    );
  });

  test("reads a stored policy and ignores unknown keys", () => {
    expect(
      parseFleetUpdatePolicy({ version: 1, channels: { beta: true, extra: 1 }, other: true }),
    ).toEqual({ version: 1, channels: { stable: false, beta: true, unstable: false } });
  });
});

describe("fleetUpdateDecision", () => {
  const on = (channels: Partial<FleetUpdatePolicy["channels"]>): FleetUpdatePolicy => ({
    version: 1,
    channels: { stable: false, beta: false, unstable: false, ...channels },
  });
  const leaf = (
    overrides: Partial<Pick<HostMaintenanceSnapshot, "version" | "updateChannel" | "job">> & {
      available?: boolean;
    } = {},
  ) => ({
    version: overrides.version ?? "2.38.0",
    updateChannel: overrides.updateChannel ?? "stable",
    job: overrides.job ?? null,
    updater: {
      kind: "standalone" as const,
      available: overrides.available ?? true,
      reason: null,
      latestVersion: null,
      updateAvailable: null,
      checkedAt: null,
      checkError: null,
    },
  });

  test("updates an older leaf on an enabled channel to the command node's version", () => {
    expect(fleetUpdateDecision(on({ stable: true }), "2.40.0", leaf())).toEqual({
      action: "update",
      version: "2.40.0",
    });
    // A Beta leaf also installs Stable releases.
    expect(
      fleetUpdateDecision(on({ beta: true }), "2.40.0", leaf({ updateChannel: "beta" })),
    ).toEqual({ action: "update", version: "2.40.0" });
  });

  test("skips what the policy must not touch", () => {
    expect(fleetUpdateDecision(DEFAULT_FLEET_UPDATE_POLICY, "2.40.0", leaf())).toEqual({
      action: "skip",
      reason: "policy-off",
    });
    expect(fleetUpdateDecision(on({ beta: true }), "2.40.0", leaf())).toMatchObject({
      reason: "policy-off",
    });
    expect(
      fleetUpdateDecision(on({ stable: true }), "2.40.0", leaf({ version: "2.41.0" })),
    ).toMatchObject({ reason: "not-older" });
    expect(
      fleetUpdateDecision(on({ stable: true }), "2.40.0", leaf({ version: "2.40.0" })),
    ).toMatchObject({ reason: "not-older" });
    // A Stable leaf never gets a beta pushed.
    expect(fleetUpdateDecision(on({ stable: true }), "2.40.0-beta", leaf())).toMatchObject({
      reason: "channel",
    });
    expect(
      fleetUpdateDecision(on({ stable: true }), "2.40.0", leaf({ available: false })),
    ).toMatchObject({ reason: "updater-unavailable" });
    const job = {
      id: "j1",
      state: "downloading",
      fromVersion: "2.38.0",
      requestedVersion: null,
      targetVersion: null,
      drain: "now",
      idleDeadline: null,
      progressPercent: null,
      restartAt: null,
      error: null,
      requestedAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
      completedAt: null,
    } as const;
    expect(fleetUpdateDecision(on({ stable: true }), "2.40.0", leaf({ job }))).toMatchObject({
      reason: "busy",
    });
  });
});
