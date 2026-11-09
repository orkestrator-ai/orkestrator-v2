/**
 * `accounts` events: agent account changes and switches. Platforms and
 * reasons stay strings so a newer backend's value is not refused.
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { AGENT_ACCOUNT_AUTO_SWITCHED_EVENT } from "../../../agent-account-auto-switch.js";
import { AGENT_USAGE_READINGS_CHANGED_EVENT } from "../../../agent-account-shared-usage.js";
import { AGENT_ACCOUNTS_CHANGED_EVENT } from "../../../agent-accounts.js";
import { COORDINATOR_ACCOUNT_SWITCHED_EVENT } from "../../../coordinator-account-switch-grant.js";
import { defineEvent } from "../../event.js";
import { accountsDomain } from "./domain.js";

/** A platform's accounts changed. */
export const agentAccountsChangedEvent = defineEvent({
  domain: accountsDomain,
  name: AGENT_ACCOUNTS_CHANGED_EVENT,
  payload: Schema.Struct({ platform: Schema.String }),
});

/**
 * A leaf's active account moved by itself (`AgentAccountAutoSwitchedEvent`,
 * in its legacy form: `five-hour` is sent as `limit`).
 */
export const agentAccountAutoSwitchedEvent = defineEvent({
  domain: accountsDomain,
  name: AGENT_ACCOUNT_AUTO_SWITCHED_EVENT,
  payload: Schema.Struct({
    platform: Schema.String,
    from: Schema.String,
    to: Schema.String,
    reason: Schema.String,
    at: Schema.String,
  }),
});

/** A coordinator switched a machine's account (`CoordinatorAccountSwitchRecord`). */
export const coordinatorAccountSwitchedEvent = defineEvent({
  domain: accountsDomain,
  name: COORDINATOR_ACCOUNT_SWITCHED_EVENT,
  payload: Schema.Struct({
    requestId: Schema.String,
    at: Schema.String,
    platform: Schema.String,
    nodeId: Schema.String,
    nodeName: Schema.String,
    toAccountId: Schema.String,
    toAccountLabel: Schema.String,
    coordinatorName: Schema.String,
    state: Schema.String,
    authorizedBy: Schema.optional(Schema.String),
    scheduleId: Schema.optional(Schema.String),
    userInstruction: Schema.optional(Schema.String),
    fromAccountId: Schema.optional(Schema.String),
    fromAccountLabel: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
});

/**
 * This machine kept a newer usage reading of one of a platform's logins: one
 * it read itself (`origin: "local"`, which its command node collects and passes
 * on) or one its command node shared with it (`"shared"`, which only tells
 * Settings to read again). Carries no reading.
 */
export const agentUsageReadingsChangedEvent = defineEvent({
  domain: accountsDomain,
  name: AGENT_USAGE_READINGS_CHANGED_EVENT,
  payload: Schema.Struct({
    platform: Schema.String,
    origin: Schema.optional(Schema.String),
  }),
});

export const ACCOUNTS_EVENTS = [
  agentAccountsChangedEvent,
  agentUsageReadingsChangedEvent,
  agentAccountAutoSwitchedEvent,
  coordinatorAccountSwitchedEvent,
] as const;
