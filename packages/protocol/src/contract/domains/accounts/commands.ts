/**
 * `accounts` commands (plan item 7008): additional Claude and Codex logins
 * (list, switch, rename, remove, sign in), automatic switching, the sign-in
 * states of every platform, plan usage and usage limits, the usage history,
 * the coordinator account-switch grant, OpenCode provider logins and the
 * Cursor SDK login.
 *
 * Argument schemas declare every key the handler reads and decode
 * tolerantly (§11.4): the 27 handlers that refused unknown keys
 * (`assertOnlyKeys`) drop them now. A key the handler required with
 * `asString`/`asNonBlankString`/`asRequiredBoolean` is typed (same "Expected
 * platform to be a string" text; the handler still refuses a blank or an
 * unsupported platform with its own words); a key it reads leniently or checks
 * with its own message (`asOptionalString` keys, the preferred `email`, the
 * OpenCode `method`, `metadata` and `inputs`, the usage-history filters) is
 * `optionalKey(Unknown)`, so nothing accepted today is refused and every
 * message is unchanged.
 *
 * No result carries a credential (`./schemas.ts`).
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import {
  GET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND,
  SET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND,
} from "../../../coordinator-account-switch-grant.js";
import { defineCommand } from "../../command.js";
import { accountsDomain } from "./domain.js";
import {
  AgentAccountLoginProgressSchema,
  AgentAccountsSnapshotSchema,
  AgentSessionAccountSchema,
  AgentSignInStatusSchema,
  AgentSignInTerminalSchema,
  CoordinatorAccountSwitchGrantStateSchema,
  CursorSdkAuthStatusSchema,
  CursorSdkLoginProgressSchema,
  HostAgentSignInsSchema,
  MachineAgentAccountsResultSchema,
  OpenCodeProviderAuthSnapshotSchema,
  OpenCodeProviderLoginProgressSchema,
  PlanUsageSnapshotSchema,
  PreferredAgentIdentitiesSchema,
  ProjectUsageLimitsSchema,
  UsageHistoryReportSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const optionalBoolean = Schema.optionalKey(Schema.Boolean);
const NoArgs = Schema.Struct({});

// ---------------------------------------------------------------------------
// Agent accounts

export const listAgentAccountsCommand = defineCommand({
  domain: accountsDomain,
  name: "list_agent_accounts",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: AgentAccountsSnapshotSchema,
  critical: [],
});

export const getAgentSignInStatusCommand = defineCommand({
  domain: accountsDomain,
  name: "get_agent_sign_in_status",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ platform: Schema.String }),
  result: AgentSignInStatusSchema,
  critical: [],
});

export const listMachineAgentAccountsCommand = defineCommand({
  domain: accountsDomain,
  name: "list_machine_agent_accounts",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: MachineAgentAccountsResultSchema,
  critical: [],
});

export const setPreferredAgentIdentityCommand = defineCommand({
  domain: accountsDomain,
  name: "set_preferred_agent_identity",
  since: 1,
  access: "workspace",
  read: false,
  // `email`: a string, or `null`/absent to clear (the handler's own text).
  args: Schema.Struct({ platform: Schema.String, email: optionalUnknown }),
  result: PreferredAgentIdentitiesSchema,
  critical: [],
});

export const readHostAgentSignInsCommand = defineCommand({
  domain: accountsDomain,
  name: "read_host_agent_sign_ins",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: HostAgentSignInsSchema,
  critical: [],
});

export const openAgentSignInTerminalCommand = defineCommand({
  domain: accountsDomain,
  name: "open_agent_sign_in_terminal",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ platform: Schema.String, environmentId: optionalUnknown }),
  result: AgentSignInTerminalSchema,
  critical: [],
});

export const getNativeAgentSessionAccountCommand = defineCommand({
  domain: accountsDomain,
  name: "get_native_agent_session_account",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Schema.String, agent: Schema.String }),
  result: AgentSessionAccountSchema,
  critical: [],
});

export const setActiveAgentAccountCommand = defineCommand({
  domain: accountsDomain,
  name: "set_active_agent_account",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ platform: Schema.String, accountId: Schema.String }),
  result: AgentAccountsSnapshotSchema,
  critical: [],
});

export const setAgentAccountAutoSwitchCommand = defineCommand({
  domain: accountsDomain,
  name: "set_agent_account_auto_switch",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    platform: Schema.String,
    enabled: optionalBoolean,
    email: optionalUnknown,
    accountId: optionalUnknown,
    included: optionalBoolean,
  }),
  result: AgentAccountsSnapshotSchema,
  critical: [],
});

export const resumeAgentAccountAutoSwitchCommand = defineCommand({
  domain: accountsDomain,
  name: "resume_agent_account_auto_switch",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ platform: Schema.String }),
  result: AgentAccountsSnapshotSchema,
  critical: [],
});

export const getCoordinatorAccountSwitchGrantCommand = defineCommand({
  domain: accountsDomain,
  name: GET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND,
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ platform: Schema.optionalKey(Schema.String) }),
  result: CoordinatorAccountSwitchGrantStateSchema,
  critical: [],
});

export const setCoordinatorAccountSwitchGrantCommand = defineCommand({
  domain: accountsDomain,
  name: SET_COORDINATOR_ACCOUNT_SWITCH_GRANT_COMMAND,
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ platform: Schema.String, enabled: Schema.Boolean }),
  result: CoordinatorAccountSwitchGrantStateSchema,
  critical: [],
});

export const renameAgentAccountCommand = defineCommand({
  domain: accountsDomain,
  name: "rename_agent_account",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ platform: Schema.String, accountId: Schema.String, label: Schema.String }),
  result: AgentAccountsSnapshotSchema,
  critical: [],
});

export const removeAgentAccountCommand = defineCommand({
  domain: accountsDomain,
  name: "remove_agent_account",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ platform: Schema.String, accountId: Schema.String }),
  result: AgentAccountsSnapshotSchema,
  critical: [],
});

export const getProjectUsageLimitsCommand = defineCommand({
  domain: accountsDomain,
  name: "get_project_usage_limits",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ projectId: Schema.String }),
  result: ProjectUsageLimitsSchema,
  critical: [],
});

export const getAgentAccountUsageCommand = defineCommand({
  domain: accountsDomain,
  name: "get_agent_account_usage",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    platform: Schema.String,
    accountId: Schema.String,
    force: optionalBoolean,
  }),
  result: PlanUsageSnapshotSchema,
  critical: [],
});

export const startAgentAccountLoginCommand = defineCommand({
  domain: accountsDomain,
  name: "start_agent_account_login",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ platform: Schema.String, reauthenticate: optionalBoolean }),
  result: AgentAccountLoginProgressSchema,
  critical: ["reauthenticate"],
});

/**
 * Sign one Claude account in again by id, active or not, replacing its
 * credential in place. A separate command rather than an `accountId` on
 * `start_agent_account_login`: an older node would ignore that key and renew
 * the active account instead, while it answers this one `unknown-command`.
 */
export const reauthenticateAgentAccountCommand = defineCommand({
  domain: accountsDomain,
  name: "reauthenticate_agent_account",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ platform: Schema.String, accountId: Schema.String }),
  result: AgentAccountLoginProgressSchema,
  critical: [],
});

export const getAgentAccountLoginCommand = defineCommand({
  domain: accountsDomain,
  name: "get_agent_account_login",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: AgentAccountLoginProgressSchema,
  critical: [],
});

export const submitAgentAccountLoginCodeCommand = defineCommand({
  domain: accountsDomain,
  name: "submit_agent_account_login_code",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ code: Schema.String }),
  result: AgentAccountLoginProgressSchema,
  critical: [],
});

export const cancelAgentAccountLoginCommand = defineCommand({
  domain: accountsDomain,
  name: "cancel_agent_account_login",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ operationId: Schema.optionalKey(Schema.String) }),
  result: AgentAccountLoginProgressSchema,
  critical: ["operationId"],
});

// ---------------------------------------------------------------------------
// Shared usage readings (docs/architecture/agent-accounts.md, "Shared readings")

/**
 * Leaf side, called by an attached command node over its link only (never
 * routed, granted or relayed; `node-routing.ts`): this machine's matchable
 * logins and its newest reading of each. Identities and readings are parsed
 * by the caller (`parseUsageIdentities`, `parseSharedUsageReadings`), which
 * keeps usage fields only. A machine that predates the command answers
 * `unknown-command` and simply takes no part.
 */
export const collectSharedUsageReadingsCommand = defineCommand({
  domain: accountsDomain,
  name: "collect_shared_usage_readings",
  since: 1,
  access: "internal",
  read: true,
  args: Schema.Struct({ controllerId: optionalUnknown }),
  result: Schema.Struct({
    identities: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    readings: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
  critical: [],
});

/**
 * Leaf side, as above: the command node's newest readings of logins this
 * machine has. Each is kept only when it is newer than what this machine
 * already has for that login, and only for a login it has.
 */
export const applySharedUsageReadingsCommand = defineCommand({
  domain: accountsDomain,
  name: "apply_shared_usage_readings",
  since: 1,
  access: "internal",
  read: false,
  args: Schema.Struct({ controllerId: optionalUnknown, readings: optionalUnknown }),
  result: Schema.Struct({
    applied: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  critical: [],
});

// ---------------------------------------------------------------------------
// Plan usage and usage history

export const getPlanUsageCommand = defineCommand({
  domain: accountsDomain,
  name: "get_plan_usage",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ platform: Schema.String, force: optionalBoolean }),
  result: PlanUsageSnapshotSchema,
  critical: [],
});

export const getUsageHistoryCommand = defineCommand({
  domain: accountsDomain,
  name: "get_usage_history",
  since: 1,
  access: "workspace",
  read: true,
  // Normalised leniently (`normalizeUsageHistoryQuery`): out-of-range values fall back.
  args: Schema.Struct({
    days: optionalUnknown,
    platform: optionalUnknown,
    environmentId: optionalUnknown,
  }),
  result: UsageHistoryReportSchema,
  critical: [],
});

// ---------------------------------------------------------------------------
// OpenCode provider logins

export const listOpenCodeProviderAuthCommand = defineCommand({
  domain: accountsDomain,
  name: "list_opencode_provider_auth",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: OpenCodeProviderAuthSnapshotSchema,
  critical: [],
});

export const setOpenCodeProviderApiKeyCommand = defineCommand({
  domain: accountsDomain,
  name: "set_opencode_provider_api_key",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ providerId: Schema.String, key: Schema.String, metadata: optionalUnknown }),
  result: Schema.Void,
  critical: ["metadata"],
});

export const removeOpenCodeProviderLoginCommand = defineCommand({
  domain: accountsDomain,
  name: "remove_opencode_provider_login",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ providerId: Schema.String }),
  result: Schema.Void,
  critical: [],
});

export const startOpenCodeProviderLoginCommand = defineCommand({
  domain: accountsDomain,
  name: "start_opencode_provider_login",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    providerId: Schema.String,
    providerLabel: optionalUnknown,
    method: optionalUnknown,
    inputs: optionalUnknown,
  }),
  result: OpenCodeProviderLoginProgressSchema,
  critical: ["inputs"],
});

export const getOpenCodeProviderLoginCommand = defineCommand({
  domain: accountsDomain,
  name: "get_opencode_provider_login",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: OpenCodeProviderLoginProgressSchema,
  critical: [],
});

export const submitOpenCodeProviderLoginCodeCommand = defineCommand({
  domain: accountsDomain,
  name: "submit_opencode_provider_login_code",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ code: Schema.String }),
  result: OpenCodeProviderLoginProgressSchema,
  critical: [],
});

export const cancelOpenCodeProviderLoginCommand = defineCommand({
  domain: accountsDomain,
  name: "cancel_opencode_provider_login",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ operationId: Schema.optionalKey(Schema.String) }),
  result: OpenCodeProviderLoginProgressSchema,
  critical: ["operationId"],
});

// ---------------------------------------------------------------------------
// Cursor SDK login

export const cursorSdkLoginStartCommand = defineCommand({
  domain: accountsDomain,
  name: "cursor_sdk_login_start",
  since: 1,
  access: "workspace",
  read: false,
  // Anything but `false` opens the link on this machine's desktop, as before the flag.
  args: Schema.Struct({ openBrowser: optionalUnknown }),
  result: Schema.Struct({ loginUrl: Schema.String }),
  critical: [],
});

export const cursorSdkLoginStatusCommand = defineCommand({
  domain: accountsDomain,
  name: "cursor_sdk_login_status",
  since: 1,
  access: "workspace",
  read: false,
  args: NoArgs,
  result: CursorSdkLoginProgressSchema,
  critical: [],
});

export const cursorSdkLoginCancelCommand = defineCommand({
  domain: accountsDomain,
  name: "cursor_sdk_login_cancel",
  since: 1,
  access: "workspace",
  read: false,
  args: NoArgs,
  result: Schema.Struct({ cancelled: Schema.Boolean }),
  critical: [],
});

export const cursorSdkLogoutCommand = defineCommand({
  domain: accountsDomain,
  name: "cursor_sdk_logout",
  since: 1,
  access: "workspace",
  read: false,
  args: NoArgs,
  result: CursorSdkAuthStatusSchema,
  critical: [],
});

/** Every `accounts` command, in registration order. */
export const ACCOUNTS_COMMANDS = [
  listAgentAccountsCommand,
  getAgentSignInStatusCommand,
  listMachineAgentAccountsCommand,
  setPreferredAgentIdentityCommand,
  readHostAgentSignInsCommand,
  openAgentSignInTerminalCommand,
  getNativeAgentSessionAccountCommand,
  setActiveAgentAccountCommand,
  setAgentAccountAutoSwitchCommand,
  resumeAgentAccountAutoSwitchCommand,
  getCoordinatorAccountSwitchGrantCommand,
  setCoordinatorAccountSwitchGrantCommand,
  renameAgentAccountCommand,
  removeAgentAccountCommand,
  getProjectUsageLimitsCommand,
  getAgentAccountUsageCommand,
  collectSharedUsageReadingsCommand,
  applySharedUsageReadingsCommand,
  startAgentAccountLoginCommand,
  reauthenticateAgentAccountCommand,
  getAgentAccountLoginCommand,
  submitAgentAccountLoginCodeCommand,
  cancelAgentAccountLoginCommand,
  getPlanUsageCommand,
  getUsageHistoryCommand,
  listOpenCodeProviderAuthCommand,
  setOpenCodeProviderApiKeyCommand,
  removeOpenCodeProviderLoginCommand,
  startOpenCodeProviderLoginCommand,
  getOpenCodeProviderLoginCommand,
  submitOpenCodeProviderLoginCodeCommand,
  cancelOpenCodeProviderLoginCommand,
  cursorSdkLoginStartCommand,
  cursorSdkLoginStatusCommand,
  cursorSdkLoginCancelCommand,
  cursorSdkLogoutCommand,
] as const;
