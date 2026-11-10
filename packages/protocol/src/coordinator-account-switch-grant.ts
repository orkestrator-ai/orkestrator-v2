/**
 * The user's standing permission for coordinators to switch the active Claude
 * or Codex account without asking (Settings → the provider's accounts).
 *
 * A coordinator's `switch_provider_account` normally files a request the user
 * approves. With the permission on for that provider, the switch runs at once
 * instead, within the guardrails below, and is recorded so the user can see
 * it afterwards. The permission is held on the machine where the approval
 * would otherwise be asked, the coordinator's own, and covers switches that
 * machine's coordinators make on itself and on the machines it controls. It is
 * not an inherited setting: a command node's choice says nothing about what a
 * leaf's own coordinators may do.
 */

import { AGENT_ACCOUNT_PLATFORMS, type AgentAccountPlatform } from "./agent-accounts.js";

/** Commands: read the permission and the recorded switches, and change one provider's. */
export const GET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND = "get_coordinator_account_switch_grant";
export const SET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND = "set_coordinator_account_switch_grant";

/** Emitted with a `CoordinatorAccountSwitchRecord` when a switch ran without asking. */
export const COORDINATOR_ACCOUNT_SWITCHED_EVENT = "coordinator-account-switched";

/**
 * Switches per target machine and provider in a rolling hour before a switch
 * asks again. A rescue needs one per machine, and a second covers a wrong
 * first choice; a third is the most a coordinator flipping accounts in a
 * loop gets before someone has to look.
 */
export const COORDINATOR_ACCOUNT_SWITCH_LIMIT = {
  switches: 3,
  windowMs: 60 * 60_000,
} as const;

/** How many recorded switches the settings view lists. */
export const MAX_LISTED_COORDINATOR_ACCOUNT_SWITCHES = 10;

/** Stored form: a provider is present only while its permission is on. */
export type CoordinatorAccountSwitchGrants = Partial<Record<AgentAccountPlatform, true>>;

export function normalizeCoordinatorAccountSwitchGrants(
  value: unknown,
): CoordinatorAccountSwitchGrants {
  const grants: CoordinatorAccountSwitchGrants = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return grants;
  for (const platform of AGENT_ACCOUNT_PLATFORMS) {
    if ((value as Record<string, unknown>)[platform] === true) grants[platform] = true;
  }
  return grants;
}

export function withCoordinatorAccountSwitchGrant(
  current: unknown,
  platform: AgentAccountPlatform,
  enabled: boolean,
): CoordinatorAccountSwitchGrants {
  const next = normalizeCoordinatorAccountSwitchGrants(current);
  if (enabled) next[platform] = true;
  else delete next[platform];
  return next;
}

/**
 * One switch a coordinator made without asking, as the user sees it: under the
 * standing permission, or under the permission the user gave one self-timer.
 */
export interface CoordinatorAccountSwitchRecord {
  /**
   * Which permission let it run. Absent on records from a backend that only
   * had the standing permission.
   */
  authorizedBy?: "standing-grant" | "self-timer";
  /** `self-timer`: the timer, and what the user asked in their own words. */
  scheduleId?: string;
  userInstruction?: string;
  requestId: string;
  at: string;
  platform: AgentAccountPlatform;
  nodeId: string;
  nodeName: string;
  fromAccountId?: string;
  fromAccountLabel?: string;
  toAccountId: string;
  toAccountLabel: string;
  /** The coordinator that switched, by its project's name. */
  coordinatorName: string;
  /** The coordinator's own words, bounded. */
  reason?: string;
  /** `executed`, `failed`, `outcome-unknown`, or `approved` while it runs. */
  state: string;
  message?: string;
}

export interface CoordinatorAccountSwitchGrantState {
  grants: Record<AgentAccountPlatform, boolean>;
  limit: { switches: number; windowMinutes: number };
  /** Newest first. */
  recentSwitches: CoordinatorAccountSwitchRecord[];
}
