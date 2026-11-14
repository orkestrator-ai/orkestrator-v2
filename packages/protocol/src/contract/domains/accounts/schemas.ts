/**
 * `accounts` result shapes (plan item 7008): agent accounts and their logins,
 * sign-in states, plan usage and usage limits, usage history, the coordinator
 * account-switch grant, OpenCode provider logins and the Cursor SDK login.
 *
 * Records are open (`modelRecord`, or {@link openRecord} for shapes that are
 * the backend's own): the declared fields (ids, states, kinds, the flags
 * callers branch on) are checked, and every other key passes a tolerant
 * decode, so a client loses nothing a newer backend adds. Enumerations a newer
 * backend may extend (platforms, states, sources) are strings. Fields older
 * backends or partial fixtures leave out are optional.
 *
 * Nothing here is a credential: no result carries a key, token or login
 * secret, only identity and sign-in state.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { DeepMutable, Mutable } from "effect/Types";
import type {
  AgentAccountIdentity,
  AgentAccountLoginProgress,
  AgentAccountsSnapshot,
  AgentAccountSummary,
  AgentSessionAccount,
  AgentSignInTerminal,
  HostAgentSignIn,
  MachineAgentAccounts,
  MachineAgentAccountsResult,
} from "../../../agent-accounts.js";
import type {
  CoordinatorAccountSwitchGrantState,
  CoordinatorAccountSwitchRecord,
} from "../../../coordinator-account-switch-grant.js";
import type { NativeAgentAuthStatus } from "../../../native-agent.js";
import type {
  OpenCodeProviderAuthEntry,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderAuthSnapshot,
  OpenCodeProviderLoginProgress,
} from "../../../opencode-provider-auth.js";
import type { PlanUsageSnapshot } from "../../../plan-usage.js";
import type { UsageEnvironmentSummary, UsageHistoryReport } from "../../../usage-history.js";
import { modelRecord, type ModelSchema, OpenObject, openRecord } from "../../model-schema.js";

const optionalString = Schema.optional(Schema.String);
const optionalBoolean = Schema.optional(Schema.Boolean);
const optionalNumber = Schema.optional(Schema.Finite);

// ---------------------------------------------------------------------------
// Agent accounts

export const AgentAccountIdentitySchema = modelRecord<AgentAccountIdentity>()({
  email: optionalString,
  organizationName: optionalString,
  plan: optionalString,
}).annotate({ identifier: "AgentAccountIdentity" });

export const AgentAccountSummarySchema = modelRecord<AgentAccountSummary>()({
  id: Schema.String,
  platform: Schema.String,
  label: Schema.String,
  isDefault: Schema.Boolean,
  isActive: Schema.Boolean,
  signedIn: Schema.Boolean,
  identity: AgentAccountIdentitySchema,
  createdAt: optionalString,
  privateEntries: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "AgentAccountSummary" });

/** One platform's accounts on a machine and which is active, with automatic switching. */
export const AgentAccountsSnapshotSchema = modelRecord<AgentAccountsSnapshot>()({
  accounts: Schema.Array(AgentAccountSummarySchema),
  active: Schema.Record(Schema.String, Schema.String),
  // Per platform (`AgentAccountAutoSwitchStates`); absent from older machines.
  autoSwitch: Schema.optional(Schema.Record(Schema.String, Schema.UndefinedOr(OpenObject))),
}).annotate({ identifier: "AgentAccountsSnapshot" });

/** The single in-flight account login, as the settings pane polls it. */
export const AgentAccountLoginProgressSchema = modelRecord<AgentAccountLoginProgress>()({
  state: Schema.String,
  operationId: optionalString,
  completedAt: optionalString,
  platform: optionalString,
  mode: optionalString,
  accountId: optionalString,
  url: optionalString,
  userCode: optionalString,
  needsCode: optionalBoolean,
  codeSubmitted: optionalBoolean,
  error: optionalString,
}).annotate({ identifier: "AgentAccountLoginProgress" });

/** Which of the machine's logins one session's bridge uses; `null` for a platform without accounts. */
export const AgentSessionAccountSchema = Schema.NullOr(
  modelRecord<AgentSessionAccount>()({
    platform: Schema.String,
    source: Schema.String,
    account: Schema.optional(AgentAccountSummarySchema),
    running: Schema.Boolean,
    pendingActive: Schema.optional(AgentAccountSummarySchema),
  }),
).annotate({ identifier: "AgentSessionAccount" });

export const HostAgentSignInSchema = modelRecord<HostAgentSignIn>()({
  state: Schema.String,
  source: optionalString,
}).annotate({ identifier: "HostAgentSignIn" });

/** Grok's and Pi's login on a machine (`HostAgentSignIns`), from files and variable names only. */
export const HostAgentSignInsSchema = Schema.Record(
  Schema.String,
  Schema.UndefinedOr(HostAgentSignInSchema),
).annotate({ identifier: "HostAgentSignIns" });

/** The preferred login's email per platform (`PreferredAgentIdentities`). */
export const PreferredAgentIdentitiesSchema = Schema.Record(
  Schema.String,
  Schema.UndefinedOr(Schema.String),
).annotate({ identifier: "PreferredAgentIdentities" });

export const MachineAgentAccountsSchema = modelRecord<MachineAgentAccounts>()({
  nodeId: Schema.String,
  name: Schema.String,
  colorToken: optionalString,
  self: Schema.Boolean,
  state: Schema.String,
  error: optionalString,
  snapshot: Schema.optional(AgentAccountsSnapshotSchema),
  signIns: Schema.optional(HostAgentSignInsSchema),
}).annotate({ identifier: "MachineAgentAccounts" });

export const MachineAgentAccountsResultSchema = modelRecord<MachineAgentAccountsResult>()({
  machines: Schema.Array(MachineAgentAccountsSchema),
  preferred: Schema.optional(PreferredAgentIdentitiesSchema),
}).annotate({ identifier: "MachineAgentAccountsResult" });

/** The terminal tab `open_agent_sign_in_terminal` opened. */
export const AgentSignInTerminalSchema: ModelSchema<AgentSignInTerminal> =
  modelRecord<AgentSignInTerminal>()({
    environmentId: Schema.String,
    projectId: Schema.String,
    tabId: Schema.String,
  }).annotate({ identifier: "AgentSignInTerminal" });

/** A platform's sign-in state for the settings pane (`NativeAgentAuthStatus`). */
export const AgentSignInStatusSchema = modelRecord<NativeAgentAuthStatus>()({
  state: Schema.String,
  pendingSignIn: Schema.optional(Schema.NullOr(OpenObject)),
  account: Schema.optional(OpenObject),
  providers: Schema.optional(
    Schema.Array(
      openRecord({
        id: Schema.String,
        label: Schema.String,
        state: Schema.String,
        method: optionalString,
      }),
    ),
  ),
  signIn: Schema.optional(openRecord({ kind: Schema.String })),
  signOut: optionalBoolean,
}).annotate({ identifier: "AgentSignInStatus" });

// ---------------------------------------------------------------------------
// Usage

const UsageWindowSchema = openRecord({
  window: Schema.String,
  label: optionalString,
  usedPercent: optionalNumber,
  remainingPercent: optionalNumber,
  resetsAt: optionalString,
});

/** A plan's quota windows for one platform or account (`PlanUsageSnapshot`). */
export const PlanUsageSnapshotSchema = modelRecord<PlanUsageSnapshot>()({
  platform: Schema.String,
  status: Schema.String,
  windows: Schema.Array(UsageWindowSchema),
  plan: optionalString,
  message: optionalString,
  paidOverage: Schema.optional(openRecord({ enabled: Schema.Boolean, inUse: optionalBoolean })),
  // Unused limit resets (Claude's free resets, Codex's banked reset credits).
  resets: Schema.optional(
    openRecord({
      available: Schema.Finite,
      items: Schema.Array(
        openRecord({
          label: optionalString,
          scope: optionalString,
          count: Schema.Finite,
          expiresAt: optionalString,
        }),
      ),
    }),
  ),
  stale: optionalBoolean,
  fetchedAt: Schema.String,
  // The machine that took a shared reading; absent for one taken here.
  readOn: Schema.optional(openRecord({ nodeId: Schema.String, nodeName: Schema.String })),
}).annotate({ identifier: "PlanUsageSnapshot" });

/**
 * Which of a project's agent tabs stopped on a provider usage limit, and the
 * active accounts' cached quota windows (the backend's `ProjectUsageLimits`).
 */
export const ProjectUsageLimitsSchema = openRecord({
  checkedAt: Schema.String,
  limitedTabs: Schema.Array(
    openRecord({
      environmentId: Schema.String,
      environmentName: Schema.String,
      tabId: Schema.NullOr(Schema.String),
      agent: Schema.String,
      observedAt: Schema.String,
      error: Schema.String,
      resetHint: optionalString,
      signal: optionalString,
    }),
  ),
  activeAccounts: Schema.Array(
    openRecord({
      platform: Schema.String,
      fetchedAt: Schema.String,
      stale: Schema.Boolean,
      exhaustedWindows: Schema.Array(UsageWindowSchema),
      windows: Schema.Array(UsageWindowSchema),
    }),
  ),
}).annotate({ identifier: "ProjectUsageLimits" });

const UsageTotalsSchema = openRecord({
  totalTokens: Schema.Finite,
  costUsd: Schema.Finite,
  turns: Schema.Finite,
});

const UsageEnvironmentSummarySchema = modelRecord<UsageEnvironmentSummary>()({
  environmentId: Schema.String,
  name: optionalString,
  projectName: optionalString,
  deleted: optionalBoolean,
  totals: UsageTotalsSchema,
  sessions: Schema.Finite,
});

/** The usage pane's report (`UsageHistoryReport`). */
export const UsageHistoryReportSchema = modelRecord<UsageHistoryReport>()({
  generatedAt: Schema.String,
  fromDay: Schema.String,
  toDay: Schema.String,
  days: Schema.Array(openRecord({ day: Schema.String, totals: UsageTotalsSchema })),
  totals: UsageTotalsSchema,
  sessions: Schema.Finite,
  platforms: Schema.Array(
    openRecord({ platform: Schema.String, totals: UsageTotalsSchema, sessions: Schema.Finite }),
  ),
  models: Schema.Array(
    openRecord({
      modelId: Schema.String,
      platform: Schema.String,
      totals: UsageTotalsSchema,
      sessions: Schema.Finite,
    }),
  ),
  environments: Schema.Array(UsageEnvironmentSummarySchema),
  recordingSince: optionalString,
  recordedPlatforms: Schema.Array(Schema.String),
}).annotate({ identifier: "UsageHistoryReport" });

// ---------------------------------------------------------------------------
// Coordinator account-switch grant

const CoordinatorAccountSwitchRecordSchema = modelRecord<CoordinatorAccountSwitchRecord>()({
  requestId: Schema.String,
  at: Schema.String,
  platform: Schema.String,
  nodeId: Schema.String,
  nodeName: Schema.String,
  toAccountId: Schema.String,
  toAccountLabel: Schema.String,
  coordinatorName: Schema.String,
  state: Schema.String,
});

/** The standing grant per platform, its limit, and the switches it allowed. */
export const CoordinatorAccountSwitchGrantStateSchema =
  modelRecord<CoordinatorAccountSwitchGrantState>()({
    grants: Schema.Record(Schema.String, Schema.Boolean),
    limit: openRecord({ switches: Schema.Finite, windowMinutes: Schema.Finite }),
    recentSwitches: Schema.Array(CoordinatorAccountSwitchRecordSchema),
  }).annotate({ identifier: "CoordinatorAccountSwitchGrantState" });

// ---------------------------------------------------------------------------
// OpenCode provider logins

const OpenCodeProviderAuthMethodSchema = modelRecord<OpenCodeProviderAuthMethod>()({
  index: Schema.Finite,
  type: Schema.String,
  label: Schema.String,
  prompts: Schema.Array(
    openRecord({ type: Schema.String, key: Schema.String, message: Schema.String }),
  ),
});

const OpenCodeProviderAuthEntrySchema = modelRecord<OpenCodeProviderAuthEntry>()({
  id: Schema.String,
  label: Schema.String,
  connected: Schema.Boolean,
  storedLogin: Schema.Boolean,
  canRemoveStoredLogin: optionalBoolean,
  allowed: Schema.Boolean,
  methods: Schema.Array(OpenCodeProviderAuthMethodSchema),
});

export const OpenCodeProviderAuthSnapshotSchema = modelRecord<OpenCodeProviderAuthSnapshot>()({
  providers: Schema.Array(OpenCodeProviderAuthEntrySchema),
}).annotate({ identifier: "OpenCodeProviderAuthSnapshot" });

export const OpenCodeProviderLoginProgressSchema = modelRecord<OpenCodeProviderLoginProgress>()({
  state: Schema.String,
  operationId: optionalString,
  providerId: optionalString,
  providerLabel: optionalString,
  url: optionalString,
  instructions: optionalString,
  userCode: optionalString,
  needsCode: optionalBoolean,
  codeSubmitted: optionalBoolean,
  error: optionalString,
  completedAt: optionalString,
}).annotate({ identifier: "OpenCodeProviderLoginProgress" });

// ---------------------------------------------------------------------------
// Cursor SDK login (plan item 7010: the models themselves; the web's
// `CursorSdkAuthStatus`/`CursorSdkLoginProgress` are these types). The
// credential source and the login state are literals: the backend writes
// only these (`cursor-sdk-bridge.ts`), and a new value bumps the domain.

/** Which credential the Cursor SDK bridge is using. */
export const CursorSdkCredentialSourceSchema = Schema.Literals([
  "api-key-env",
  "api-key-config",
  "host-snapshot",
  "stored-login",
  "none",
]);
export type CursorSdkCredentialSource = typeof CursorSdkCredentialSourceSchema.Type;

/** Whether the Cursor SDK engine can run a turn, and which credential is in play (never the key). */
export const CursorSdkAuthStatusSchema = openRecord({
  authenticated: Schema.Boolean,
  source: CursorSdkCredentialSourceSchema,
  email: optionalString,
  expiresAt: optionalString,
}).annotate({ identifier: "CursorSdkAuthStatus" });
export type CursorSdkAuthStatus = Mutable<typeof CursorSdkAuthStatusSchema.Type>;

/** The backend's single Cursor login: its state, its URL while pending, and the credential after it. */
export const CursorSdkLoginStateSchema = Schema.Literals([
  "pending",
  "authenticated",
  "failed",
  "idle",
]);
export type CursorSdkLoginState = typeof CursorSdkLoginStateSchema.Type;

export const CursorSdkLoginProgressSchema = openRecord({
  state: CursorSdkLoginStateSchema,
  loginUrl: optionalString,
  error: optionalString,
  auth: CursorSdkAuthStatusSchema,
}).annotate({ identifier: "CursorSdkLoginProgress" });
export type CursorSdkLoginProgress = DeepMutable<typeof CursorSdkLoginProgressSchema.Type>;
