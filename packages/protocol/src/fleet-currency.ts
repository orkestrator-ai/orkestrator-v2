/**
 * Keeping one user's fleet current (docs/reports/unified-federation.md §11.6,
 * plan item 5006): how a node's release relates to its command node's, which
 * contract domains it lacks, and the opt-in policy that keeps leaves on the
 * command node's version.
 *
 * Browser-safe: no Node or Bun imports.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  HOST_UPDATE_CHANNELS,
  hostUpdateChannelOfVersion,
  hostUpdateChannelsReceived,
  isActiveHostUpdateJob,
  isHostUpdateChannel,
  isHostVersion,
  type HostMaintenanceSnapshot,
  type HostUpdateChannel,
} from "./host-maintenance.js";
import type { NegotiatedDomains } from "./node-client.js";

type ParsedVersion = { core: [number, number, number]; prerelease: string[] };

function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
    version.trim(),
  );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver order of two Orkestrator releases: negative when `left` is older,
 * positive when newer, 0 when equal; `null` when either is not a release
 * version, so no caller guesses which side is older.
 */
export function compareReleaseVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = a.prerelease[index];
    const r = b.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const order = comparePrerelease(l, r);
    if (order !== 0) return order;
  }
  return 0;
}

/*
 * Version skew in the sidebar
 */

/**
 * What a machine's current connection announced. `version: null` when it is
 * not connected (or the command node predates the field); `domains: null`
 * when its hello has none, which for a connected machine means it predates
 * domain contracts.
 */
export interface MachineRelease {
  readonly version: string | null;
  readonly domains: NegotiatedDomains | null;
}

export interface MachineCurrency {
  /** The machine's own version. */
  readonly version: string;
  /** The command node's version it is compared with. */
  readonly commandVersion: string;
  /** `different` when either side is not a release version. */
  readonly relation: "older" | "newer" | "different";
  /** Its hello has no `domains`: a release from before domain contracts. */
  readonly preContract: boolean;
  /**
   * The command node's domains the machine cannot serve, sorted: not
   * advertised at all, or advertised with a range that does not overlap.
   */
  readonly lacks: readonly string[];
}

function ownRange(domains: NegotiatedDomains, name: string) {
  return Object.prototype.hasOwnProperty.call(domains, name) ? domains[name] : undefined;
}

/**
 * How `machine` relates to its command node, or `null` when there is nothing
 * to show: same version, or either version unknown.
 */
export function machineCurrency(
  machine: MachineRelease,
  command: MachineRelease,
): MachineCurrency | null {
  const version = machine.version?.trim();
  const commandVersion = command.version?.trim();
  if (!version || !commandVersion || version === commandVersion) return null;
  const order = compareReleaseVersions(version, commandVersion);
  if (order === 0) return null;
  const preContract = machine.domains === null;
  const lacks: string[] = [];
  for (const name of Object.keys(command.domains ?? {}).sort()) {
    const wanted = ownRange(command.domains!, name)!;
    const own = machine.domains ? ownRange(machine.domains, name) : undefined;
    if (!own || own.max < wanted.min || own.min > wanted.max) lacks.push(name);
  }
  return {
    version,
    commandVersion,
    relation: order === null ? "different" : order < 0 ? "older" : "newer",
    preContract,
    lacks,
  };
}

/*
 * The update policy
 */

/**
 * Per update channel: whether the command node keeps the leaves on that
 * channel on its own version. A leaf counts under its own channel.
 */
export interface FleetUpdatePolicy {
  readonly version: 1;
  readonly channels: Readonly<Record<HostUpdateChannel, boolean>>;
}

/**
 * Off for every channel: the report (§11.6) calls the policy opt-in. The plan
 * (5006) asks the user to confirm this default; until then nothing updates a
 * machine without the user asking.
 */
export const DEFAULT_FLEET_UPDATE_POLICY: FleetUpdatePolicy = Object.freeze({
  version: 1,
  channels: Object.freeze({ stable: false, beta: false, unstable: false }),
});

/** The policy as a command answers it: every channel present. */
export const FleetUpdatePolicyWireSchema = Schema.Struct({
  version: Schema.Literal(1),
  channels: Schema.Struct({
    stable: Schema.Boolean,
    beta: Schema.Boolean,
    unstable: Schema.Boolean,
  }),
});

/** A stored or received policy, read tolerantly: a missing channel is off. */
const FleetUpdatePolicySchema = Schema.Struct({
  version: Schema.Literal(1),
  channels: Schema.Struct({
    stable: Schema.optionalKey(Schema.Boolean),
    beta: Schema.optionalKey(Schema.Boolean),
    unstable: Schema.optionalKey(Schema.Boolean),
  }),
});

const decodePolicy = Schema.decodeUnknownResult(FleetUpdatePolicySchema);

/** A stored or received policy; anything malformed reads as the default. */
export function parseFleetUpdatePolicy(value: unknown): FleetUpdatePolicy {
  const decoded = decodePolicy(value);
  if (Result.isFailure(decoded)) return DEFAULT_FLEET_UPDATE_POLICY;
  const channels = decoded.success.channels;
  return {
    version: 1,
    channels: {
      stable: channels.stable === true,
      beta: channels.beta === true,
      unstable: channels.unstable === true,
    },
  };
}

export function fleetUpdatePolicyEnabled(policy: FleetUpdatePolicy): boolean {
  return HOST_UPDATE_CHANNELS.some((channel) => policy.channels[channel]);
}

export type FleetUpdateSkip =
  /** The policy is off for the leaf's channel. */
  | "policy-off"
  /** The leaf is not older than the command node (the policy never downgrades). */
  | "not-older"
  /** The command node's release is not on a channel the leaf installs. */
  | "channel"
  | "updater-unavailable"
  /** An update is already running there. */
  | "busy";

export type FleetUpdateDecision =
  | { readonly action: "update"; readonly version: string }
  | { readonly action: "skip"; readonly reason: FleetUpdateSkip };

/**
 * Whether the command node should ask a leaf to install the command node's
 * version, from the leaf's own maintenance snapshot. Only an older leaf is
 * updated, and only to a release its own channel ships.
 */
export function fleetUpdateDecision(
  policy: FleetUpdatePolicy,
  commandVersion: string,
  leaf: Pick<HostMaintenanceSnapshot, "version" | "updateChannel" | "updater" | "job">,
): FleetUpdateDecision {
  const channel = isHostUpdateChannel(leaf.updateChannel) ? leaf.updateChannel : "stable";
  if (!policy.channels[channel]) return { action: "skip", reason: "policy-off" };
  if (!isHostVersion(commandVersion)) return { action: "skip", reason: "not-older" };
  const order = compareReleaseVersions(leaf.version, commandVersion);
  if (order === null || order >= 0) return { action: "skip", reason: "not-older" };
  const release = hostUpdateChannelOfVersion(commandVersion);
  if (!release || !hostUpdateChannelsReceived(channel).includes(release)) {
    return { action: "skip", reason: "channel" };
  }
  if (!leaf.updater.available) return { action: "skip", reason: "updater-unavailable" };
  if (isActiveHostUpdateJob(leaf.job)) return { action: "skip", reason: "busy" };
  return { action: "update", version: commandVersion };
}
