/**
 * Capability profiles (plan P1.6; decisions D4, D12, D18; report §6.1–§6.5,
 * §6.7).
 *
 * A node names a profile (`observer`, `reviewer`, `verifier`, `researcher`,
 * `builder` or `custom`) and may adjust it with `allow` and `deny`. This module
 * says what that means:
 *
 * - `compileGraphCapabilities` layers the profile over the environment's own
 *   execution policy and the project's capability ceiling. The result can
 *   only narrow the environment's policy (invariant 7): sandbox, approvals,
 *   network access, tool policy and id are the environment's; capability
 *   denials are the union of all three layers; hosted search survives a
 *   network denial only where every layer allows it.
 * - Every agent profile, `custom` included, denies `git.push` and
 *   `github.write` (D12): only system nodes push or write to GitHub. There is
 *   no `shipper`; conflict resolution uses `builder`, which commits locally.
 * - `mcp:<server>` in `allow` grants that user MCP server to the node's
 *   session (item 404); every compiled policy selects its servers through
 *   `capabilityPolicy.userMcpServers`, so a node gets none unless granted.
 * - `checkGraphCapabilities` gives the compiler (item 107) its diagnostics:
 *   remote writes asked for, MCP grants a provider cannot deliver, allows
 *   that change nothing, and `workspaceAccess` that disagrees with the
 *   profile.
 * - `graphGrantedActions` lists the Orkestrator actions an activation's
 *   credential carries (report §6.5); `describeGraphCapabilities` writes the
 *   capability statement for the locked system contract (item 105).
 *
 * The enforcement matrix lives in `capability-enforcement.ts` and is
 * re-exported here, so `@orkestrator/protocol/graphs/capability-profiles` is
 * the one import for all of it. Browser-safe.
 */
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "../agent-platforms.js";
import {
  compareNativeAgentCapabilities,
  isNativeAgentCapability,
  NATIVE_AGENT_USER_MCP_SELECTION,
  NATIVE_AGENT_USER_MCP_SERVERS_MAX,
  nativeAgentUserMcpSelectionDelivered,
  nativeAgentDeniedCapabilities,
  nativeAgentDenialsAreReadOnly,
  nativeAgentMcpServer,
  nativeAgentOrkestratorGroup,
  NATIVE_AGENT_ORKESTRATOR_CAPABILITY_GROUPS,
  type NativeAgentCapability,
  type NativeAgentExecutionPolicy,
  type NativeAgentOrkestratorCapabilityGroup,
  type NativeAgentPlainCapability,
} from "../native-agent.js";
import { AGENT_MAIL_TOOL_NAMES } from "../agent-mail.js";
import { ARTIFACT_TOOL_NAMES } from "../transcript-artifacts.js";
import type { AgentEnforcementJudgement, AgentEnforcementTier } from "./capability-enforcement.js";
import type {
  GraphCapabilityName,
  GraphCapabilityProfileId,
  GraphCapabilitySpec,
  GraphRenderMode,
  GraphWorkspaceAccess,
} from "./template-model.js";

export * from "./capability-enforcement.js";

// ------------------------------------------------------------------ profiles

/** Capabilities no agent node ever holds (D12). */
export const GRAPH_REMOTE_WRITE_CAPABILITIES = ["git.push", "github.write"] as const;

export interface GraphCapabilityProfileDefinition {
  id: GraphCapabilityProfileId;
  label: string;
  description: string;
  /** What the profile denies before node overrides. */
  deny: readonly NativeAgentPlainCapability[];
  /** Exceptions carved out of `deny`; only hosted search under a network denial. */
  allow: readonly "web.search"[];
  /** Today's equivalent, for the designer (report §6.2). */
  equivalent: string;
}

const READ_ONLY_DENIALS = ["file.write", "file.patch", "shell.mutate"] as const;
const REMOTE_DENIALS = GRAPH_REMOTE_WRITE_CAPABILITIES;

/**
 * The built-in profiles. Orkestrator tool groups are opt-in on every profile
 * (`allow: ["orkestrator:<group>"]`), so none lists them.
 */
export const GRAPH_CAPABILITY_PROFILE_DEFINITIONS: Readonly<
  Record<GraphCapabilityProfileId, GraphCapabilityProfileDefinition>
> = Object.freeze({
  observer: Object.freeze({
    id: "observer",
    label: "Observer",
    description: "Reads the workspace and its inputs. No shell, no network, no sub-agents.",
    deny: Object.freeze([
      ...READ_ONLY_DENIALS,
      "shell",
      "network",
      "subagents",
      "git.commit",
      ...REMOTE_DENIALS,
    ] as const),
    allow: Object.freeze([]),
    equivalent: "consolidation (a read-only report turn)",
  }),
  reviewer: Object.freeze({
    id: "reviewer",
    label: "Reviewer",
    description: "Reads the workspace and runs reading commands (git diff, show, log). No network.",
    deny: Object.freeze([
      ...READ_ONLY_DENIALS,
      "network",
      "git.commit",
      ...REMOTE_DENIALS,
    ] as const),
    allow: Object.freeze([]),
    equivalent: "a Multi Review reviewer (plan mode and a read-only turn)",
  }),
  verifier: Object.freeze({
    id: "verifier",
    label: "Verifier",
    description:
      "Runs checks and builds with a full shell, but edits no files and commits nothing; a guard checks the workspace afterwards.",
    deny: Object.freeze(["file.write", "file.patch", "git.commit", ...REMOTE_DENIALS] as const),
    allow: Object.freeze([]),
    equivalent: "the Build Pipeline's Verify, with its git baseline",
  }),
  researcher: Object.freeze({
    id: "researcher",
    label: "Researcher",
    description:
      "Reads the workspace and searches the web. No shell; other network access only if the node allows `network`.",
    deny: Object.freeze([
      ...READ_ONLY_DENIALS,
      "shell",
      "network",
      "git.commit",
      ...REMOTE_DENIALS,
    ] as const),
    allow: Object.freeze(["web.search"] as const),
    equivalent: "the coordinator's web research (search under a network denial)",
  }),
  builder: Object.freeze({
    id: "builder",
    label: "Builder",
    description:
      "Edits files, runs any command and commits locally. Never pushes or writes to GitHub; a system node does that.",
    deny: Object.freeze([...REMOTE_DENIALS] as const),
    allow: Object.freeze([]),
    equivalent: "Build, Fix, Address, Prepare and conflict resolution",
  }),
  custom: Object.freeze({
    id: "custom",
    label: "Custom",
    description:
      "Starts from the builder's capabilities; the node's `deny` removes what it should not do.",
    deny: Object.freeze([...REMOTE_DENIALS] as const),
    allow: Object.freeze([]),
    equivalent: "any combination",
  }),
});

// ------------------------------------------------------------------- ceiling

/**
 * The per-project capability ceiling (D18). Item 109 stores it; this module
 * applies it. Same shape and meaning as `capabilityPolicy`: `deny` removes
 * capabilities from every node in the project, and `allow` may keep hosted
 * search under a network denial. The default denies nothing, so every agent
 * capability is available up to the environment's own policy. Push and GitHub
 * writes are outside the ceiling altogether: no node gets them whatever it
 * says, so the ceiling neither lists nor grants them.
 */
export interface GraphCapabilityCeiling {
  deny: NativeAgentCapability[];
  allow?: "web.search"[];
}

export const DEFAULT_GRAPH_CAPABILITY_CEILING: Readonly<GraphCapabilityCeiling> = Object.freeze({
  deny: [],
});

/** Most entries a ceiling may list. */
export const GRAPH_CAPABILITY_CEILING_MAX_ENTRIES = 64;

export interface GraphCapabilityCeilingIssue {
  path: string;
  message: string;
}

/** Check a stored ceiling; an empty list means it is valid. */
export function graphCapabilityCeilingIssues(value: unknown): GraphCapabilityCeilingIssue[] {
  const issues: GraphCapabilityCeilingIssue[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ path: "$", message: "Expected an object with `deny` and optional `allow`" }];
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "deny" && key !== "allow") issues.push({ path: key, message: "Unknown field" });
  }
  if (!Array.isArray(record.deny)) {
    issues.push({ path: "deny", message: "Expected a list of capabilities" });
  } else {
    if (record.deny.length > GRAPH_CAPABILITY_CEILING_MAX_ENTRIES) {
      issues.push({
        path: "deny",
        message: `At most ${GRAPH_CAPABILITY_CEILING_MAX_ENTRIES} capabilities`,
      });
    }
    const seen = new Set<string>();
    record.deny.forEach((entry, index) => {
      const path = `deny[${index}]`;
      if (!isNativeAgentCapability(entry)) {
        issues.push({ path, message: "Not a capability" });
      } else if ((REMOTE_DENIALS as readonly string[]).includes(entry)) {
        issues.push({
          path,
          message: `${entry} is outside the ceiling: agent nodes never hold it, whatever the ceiling says`,
        });
      } else if (seen.has(entry)) {
        issues.push({ path, message: `Duplicate capability "${entry}"` });
      }
      if (typeof entry === "string") seen.add(entry);
    });
  }
  if (record.allow !== undefined) {
    if (
      !Array.isArray(record.allow) ||
      record.allow.length > 1 ||
      record.allow.some((entry) => entry !== "web.search")
    ) {
      issues.push({ path: "allow", message: "Only `web.search` may be allowed" });
    }
  }
  return issues;
}

export function isGraphCapabilityCeiling(value: unknown): value is GraphCapabilityCeiling {
  return graphCapabilityCeilingIssues(value).length === 0;
}

// --------------------------------------------------------------- compilation

/** What a capability set leaves available, for comparing layers. */
interface CapabilityLayer {
  deny: ReadonlySet<string>;
  allowSearch: boolean;
}

function layerAllows(layer: CapabilityLayer, capability: string): boolean {
  if (capability === "web.search") {
    return !layer.deny.has("web.search") && (!layer.deny.has("network") || layer.allowSearch);
  }
  return !layer.deny.has(capability);
}

function environmentLayer(policy: NativeAgentExecutionPolicy): CapabilityLayer {
  return {
    deny: new Set(nativeAgentDeniedCapabilities(policy)),
    allowSearch: policy.capabilityPolicy?.allow?.includes("web.search") === true,
  };
}

export interface GraphCapabilityCompileInput {
  spec: GraphCapabilitySpec;
  /** The environment's resolved policy (`resolveEnvironmentExecutionPolicy`). */
  environment: NativeAgentExecutionPolicy;
  /** The project's ceiling; `DEFAULT_GRAPH_CAPABILITY_CEILING` when absent. */
  ceiling?: GraphCapabilityCeiling;
}

export interface CompiledGraphCapabilities {
  profile: GraphCapabilityProfileId;
  /**
   * The session policy: the environment's, with the union of every layer's
   * denials. Canonical form; send it to a bridge through
   * `nativeAgentPolicyForBridge`.
   */
  policy: NativeAgentExecutionPolicy;
  /** Every capability denied, sorted (`compareNativeAgentCapabilities`). */
  denied: NativeAgentCapability[];
  /** Whether hosted search stays available. */
  webSearch: boolean;
  /**
   * Whether no file tool may write and the shell may not mutate. Dispatch
   * such a node as a read-only turn: that is where each bridge holds its
   * strongest boundary, and what the enforcement matrix rates.
   */
  readOnly: boolean;
  /** Orkestrator tool groups the node opted into and the ceiling admits. */
  orkestratorGroups: NativeAgentOrkestratorCapabilityGroup[];
  /**
   * User MCP servers granted to the node's session (item 404), sorted: its
   * `mcp:<server>` allows that no layer denies. The policy's
   * `capabilityPolicy.userMcpServers`; empty means no user server.
   */
  mcpServers: string[];
  /** What the profile and node would have had but the ceiling removed (sorted). */
  removedByCeiling: GraphCapabilityName[];
  /** What the profile and node would have had but the environment does not give (sorted). */
  removedByEnvironment: GraphCapabilityName[];
  /** D4: `provider-configured` for read-only profiles, else none. */
  defaultMinEnforcement?: AgentEnforcementTier;
}

/** The capabilities whose availability the layers can disagree on. */
function comparableCapabilities(...sets: Iterable<string>[]): string[] {
  const names = new Set<string>([
    "file.write",
    "file.patch",
    "shell",
    "shell.mutate",
    "network",
    "web.search",
    "git.commit",
    "subagents",
  ]);
  for (const set of sets) for (const name of set) if (name.startsWith("mcp:")) names.add(name);
  return [...names];
}

function sortCapabilities<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort(compareNativeAgentCapabilities);
}

/**
 * Compile a node's capability spec over the environment's policy and the
 * project's ceiling. Invalid overrides (remote writes, MCP grants) are ignored
 * here and reported by `checkGraphCapabilities`; compiling never widens.
 */
export function compileGraphCapabilities(
  input: GraphCapabilityCompileInput,
): CompiledGraphCapabilities {
  const definition = GRAPH_CAPABILITY_PROFILE_DEFINITIONS[input.spec.profile];
  const ceiling = input.ceiling ?? DEFAULT_GRAPH_CAPABILITY_CEILING;

  // The profile layer: its denials, the node's extra denials, then the node's
  // carve-outs. Remote writes can never be carved out (D12). An MCP server is
  // a grant rather than a carve-out (item 404), collected separately.
  const profileDeny = new Set<string>(definition.deny);
  let profileSearch = definition.allow.includes("web.search");
  for (const capability of input.spec.deny ?? []) {
    if (nativeAgentOrkestratorGroup(capability)) continue;
    profileDeny.add(capability);
    if (capability === "web.search") profileSearch = false;
  }
  const requestedGroups = new Set<NativeAgentOrkestratorCapabilityGroup>();
  const requestedServers = new Set<string>();
  for (const capability of input.spec.allow ?? []) {
    const group = nativeAgentOrkestratorGroup(capability);
    if (group) {
      requestedGroups.add(group);
      continue;
    }
    if ((REMOTE_DENIALS as readonly string[]).includes(capability)) continue;
    const server = nativeAgentMcpServer(capability);
    if (server) {
      requestedServers.add(server);
      continue;
    }
    if (capability === "web.search") {
      profileDeny.delete("web.search");
      profileSearch = true;
      continue;
    }
    profileDeny.delete(capability);
  }
  for (const capability of input.spec.deny ?? []) {
    const group = nativeAgentOrkestratorGroup(capability);
    if (group) requestedGroups.delete(group);
  }
  const profile: CapabilityLayer = { deny: profileDeny, allowSearch: profileSearch };
  const ceilingLayer: CapabilityLayer = {
    deny: new Set(ceiling.deny),
    allowSearch: ceiling.allow?.includes("web.search") === true,
  };
  const environment = environmentLayer(input.environment);

  // Orkestrator groups a ceiling or environment denies stay in the denial
  // list, so the policy never claims more than either layer; they never reach
  // a bridge (`nativeAgentPolicyForBridge`). The profile layer holds none:
  // groups are opt-in, granted below.
  const deny = new Set<string>([...profile.deny, ...ceilingLayer.deny, ...environment.deny]);
  for (const capability of REMOTE_DENIALS) deny.add(capability);
  const webSearch = [profile, ceilingLayer, environment].every((layer) =>
    layerAllows(layer, "web.search"),
  );
  if (!webSearch && !deny.has("network")) deny.add("web.search");
  if (webSearch) deny.delete("web.search");

  const universe = comparableCapabilities(profile.deny, ceilingLayer.deny, environment.deny);
  const removed = (layer: CapabilityLayer) =>
    sortCapabilities(
      universe.filter(
        (capability) => layerAllows(profile, capability) && !layerAllows(layer, capability),
      ) as GraphCapabilityName[],
    );
  const groupsRemovedBy = (layer: CapabilityLayer) =>
    [...requestedGroups]
      .filter((group) => layer.deny.has(`orkestrator:${group}`))
      .map((group) => `orkestrator:${group}` as const);
  const orkestratorGroups = NATIVE_AGENT_ORKESTRATOR_CAPABILITY_GROUPS.filter(
    (group) => requestedGroups.has(group) && !deny.has(`orkestrator:${group}`),
  );

  // A grant survives only where no layer denies the server; the node's own
  // denial wins over its own grant. Bounded like the wire form.
  const mcpServers = [...requestedServers]
    .filter((server) => !deny.has(`mcp:${server}`))
    .sort()
    .slice(0, NATIVE_AGENT_USER_MCP_SERVERS_MAX);
  const serversRemovedBy = (layer: CapabilityLayer) =>
    [...requestedServers]
      .filter((server) => layer.deny.has(`mcp:${server}`))
      .map((server) => `mcp:${server}` as const);

  const denied = sortCapabilities(deny as Set<NativeAgentCapability>);
  const readOnly = nativeAgentDenialsAreReadOnly(denied);
  const policy: NativeAgentExecutionPolicy = {
    ...input.environment,
    ...(input.environment.toolPolicy
      ? {
          toolPolicy: {
            ...(input.environment.toolPolicy.allow
              ? { allow: [...input.environment.toolPolicy.allow] }
              : {}),
            ...(input.environment.toolPolicy.deny
              ? { deny: [...input.environment.toolPolicy.deny] }
              : {}),
          },
        }
      : {}),
    capabilityPolicy: {
      deny: denied,
      ...(webSearch && deny.has("network") ? { allow: ["web.search"] } : {}),
      userMcpServers: [...mcpServers],
    },
  };
  return {
    profile: input.spec.profile,
    policy,
    denied,
    webSearch,
    readOnly,
    orkestratorGroups,
    mcpServers,
    removedByCeiling: sortCapabilities([
      ...removed(ceilingLayer),
      ...groupsRemovedBy(ceilingLayer),
      ...serversRemovedBy(ceilingLayer),
    ]),
    removedByEnvironment: sortCapabilities([
      ...removed(environment),
      ...groupsRemovedBy(environment),
      ...serversRemovedBy(environment),
    ]),
    ...(readOnly ? { defaultMinEnforcement: "provider-configured" as const } : {}),
  };
}

/** D4: the floor a node gets when it names none. */
export function defaultGraphMinEnforcement(
  compiled: Pick<CompiledGraphCapabilities, "readOnly">,
): AgentEnforcementTier | undefined {
  return compiled.readOnly ? "provider-configured" : undefined;
}

/** The floor that applies to a node: its own, or the profile's default. */
export function effectiveGraphMinEnforcement(
  minEnforcement: AgentEnforcementTier | undefined,
  compiled: Pick<CompiledGraphCapabilities, "readOnly">,
): AgentEnforcementTier | undefined {
  return minEnforcement ?? defaultGraphMinEnforcement(compiled);
}

const FLOOR_RANK: Readonly<Record<AgentEnforcementTier, number>> = Object.freeze({
  enforced: 0,
  "provider-configured": 1,
  advisory: 2,
});

/**
 * Whether a node's own floor is weaker than its profile's default. D4 lets the
 * user lower it, with an explicit acknowledgement (an `enforcement-floor`
 * acknowledgement in the template), which the compiler requires when this
 * is true.
 */
export function graphMinEnforcementLowered(
  minEnforcement: AgentEnforcementTier | undefined,
  compiled: Pick<CompiledGraphCapabilities, "readOnly">,
): boolean {
  const floor = defaultGraphMinEnforcement(compiled);
  return (
    minEnforcement !== undefined &&
    floor !== undefined &&
    FLOOR_RANK[minEnforcement] > FLOOR_RANK[floor]
  );
}

// ---------------------------------------------------------------- the checks

export const GRAPH_CAPABILITY_ISSUE_CODES = [
  "capability-remote-write",
  "capability-mcp-grant",
  "capability-mcp-grant-read-only",
  "capability-allow-unused",
  "capability-workspace-write-denied",
  "capability-workspace-read-writable",
] as const;
export type GraphCapabilityIssueCode = (typeof GRAPH_CAPABILITY_ISSUE_CODES)[number];

export interface GraphCapabilityIssue {
  code: GraphCapabilityIssueCode;
  severity: "error" | "warning";
  /** The override the issue is about, when there is one. */
  capability?: GraphCapabilityName;
  /** The provider the issue is about (`capability-mcp-grant`). */
  provider?: AgentPlatform;
  message: string;
}

export interface GraphCapabilityCheckOptions {
  /**
   * The enabled providers. A user MCP grant gets one `capability-mcp-grant`
   * warning per provider that cannot deliver it (item 404); without the
   * list, none.
   */
  providers?: readonly AgentPlatform[];
}

/** Whether a spec asks for push or GitHub writes, which no agent node may hold (D12). */
export function graphCapabilitySpecRequestsRemoteWrite(spec: GraphCapabilitySpec): boolean {
  return (spec.allow ?? []).some((capability) =>
    (REMOTE_DENIALS as readonly string[]).includes(capability),
  );
}

/** A policy that denies nothing, for judging a profile on its own. */
const UNRESTRICTED_ENVIRONMENT: NativeAgentExecutionPolicy = Object.freeze({
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
}) as NativeAgentExecutionPolicy;

/**
 * Whether `workspaceAccess` agrees with what the profile lets the node do.
 *
 * `write` needs file tools that may write. `read` and `none` need file tools
 * that may not; the shell may still write (a verifier's builds), which the
 * post-hoc guard holds for git-visible paths. Judged on the profile and the
 * node's overrides alone, so the environment or ceiling never turn a valid
 * template invalid.
 */
export function checkGraphWorkspaceAccess(
  spec: GraphCapabilitySpec,
  workspaceAccess: GraphWorkspaceAccess,
): GraphCapabilityIssue[] {
  const compiled = compileGraphCapabilities({ spec, environment: UNRESTRICTED_ENVIRONMENT });
  const fileToolsWrite =
    !compiled.denied.includes("file.write") || !compiled.denied.includes("file.patch");
  if (workspaceAccess === "write" && !fileToolsWrite) {
    return [
      {
        code: "capability-workspace-write-denied",
        severity: "error",
        message: `workspaceAccess "write" needs a profile whose file tools may write; ${spec.profile} denies them.`,
      },
    ];
  }
  if (workspaceAccess !== "write" && fileToolsWrite) {
    return [
      {
        code: "capability-workspace-read-writable",
        severity: "error",
        message: `workspaceAccess "${workspaceAccess}" needs a profile that cannot write files; ${spec.profile} can. Deny file.write and file.patch, or use "write".`,
      },
    ];
  }
  return [];
}

/**
 * The diagnostics for a node's user MCP grants (item 404): one warning per
 * enabled provider that cannot deliver them on the node's turn kind, and one
 * for a read-only node, whose granted servers run outside its read-only
 * boundary. A grant the node also denies is no grant.
 */
function checkGraphMcpGrants(
  spec: GraphCapabilitySpec,
  options: GraphCapabilityCheckOptions,
): GraphCapabilityIssue[] {
  const granted = (spec.allow ?? []).filter(
    (capability) => nativeAgentMcpServer(capability) && !spec.deny?.includes(capability),
  );
  if (granted.length === 0) return [];
  const issues: GraphCapabilityIssue[] = [];
  const readOnly = compileGraphCapabilities({
    spec,
    environment: UNRESTRICTED_ENVIRONMENT,
  }).readOnly;
  const servers = granted.join(", ");
  for (const provider of options.providers ?? []) {
    if (nativeAgentUserMcpSelectionDelivered(provider, readOnly)) continue;
    issues.push({
      code: "capability-mcp-grant",
      severity: "warning",
      capability: granted[0]!,
      provider,
      message: `${AGENT_PLATFORM_LABELS[provider]} cannot give this node ${servers}: ${NATIVE_AGENT_USER_MCP_SELECTION[provider].gap ?? "it cannot select MCP servers per session."}`,
    });
  }
  if (readOnly) {
    issues.push({
      code: "capability-mcp-grant-read-only",
      severity: "warning",
      capability: granted[0]!,
      message: `${servers} ${granted.length === 1 ? "runs" : "run"} outside this read-only node's boundary: an MCP server acts with your rights (a local one is a program on this machine). The workspace guard still checks the workspace afterwards.`,
    });
  }
  return issues;
}

/** Every capability diagnostic for one agent node, in a stable order. */
export function checkGraphCapabilities(
  spec: GraphCapabilitySpec,
  workspaceAccess: GraphWorkspaceAccess,
  options: GraphCapabilityCheckOptions = {},
): GraphCapabilityIssue[] {
  const issues: GraphCapabilityIssue[] = [];
  const definition = GRAPH_CAPABILITY_PROFILE_DEFINITIONS[spec.profile];
  for (const capability of spec.allow ?? []) {
    if ((REMOTE_DENIALS as readonly string[]).includes(capability)) {
      issues.push({
        code: "capability-remote-write",
        severity: "error",
        capability,
        message: `Agent nodes never hold ${capability}: pushing and GitHub writes are system nodes (D12). Add a push-branch or open-pull-request node instead.`,
      });
    } else if (nativeAgentMcpServer(capability)) {
      // A grant (item 404); judged per provider below.
      continue;
    } else if (
      !nativeAgentOrkestratorGroup(capability) &&
      !(definition.deny as readonly string[]).includes(capability) &&
      !(
        capability === "web.search" &&
        definition.deny.includes("network") &&
        !definition.allow.includes("web.search")
      )
    ) {
      issues.push({
        code: "capability-allow-unused",
        severity: "warning",
        capability,
        message: `The ${spec.profile} profile does not deny ${capability}, so allowing it changes nothing.`,
      });
    }
  }
  issues.push(...checkGraphMcpGrants(spec, options));
  issues.push(...checkGraphWorkspaceAccess(spec, workspaceAccess));
  return issues;
}

// ----------------------------------------------------------- granted actions

/** The tools each Orkestrator group opens, under the activation's credential. */
export const GRAPH_ORKESTRATOR_GROUP_TOOLS: Readonly<
  Record<NativeAgentOrkestratorCapabilityGroup, readonly string[]>
> = Object.freeze({
  "tickets.read": Object.freeze(["get_ticket", "list_tickets"]),
  "tickets.write": Object.freeze(["create_ticket", "update_ticket", "add_ticket_comment"]),
  mail: AGENT_MAIL_TOOL_NAMES,
  artifacts: ARTIFACT_TOOL_NAMES,
  schedules: Object.freeze(["create_schedule", "list_schedules", "cancel_schedule"]),
});

export interface GraphGrantedActionsInput {
  outputs?: readonly { name: string; type: string }[];
  inputs?: readonly { name: string; render?: GraphRenderMode }[];
  /** `askHuman: true` on the node (D15). */
  askHuman?: boolean;
  /** From `compileGraphCapabilities`. */
  orkestratorGroups: readonly NativeAgentOrkestratorCapabilityGroup[];
  /** Whether a type reference resolves to a type with `items` (item 102's library). */
  typeHasItems: (type: string) => boolean;
}

/**
 * The actions an activation's credential exposes (report §6.5). The backend
 * enforces these: a tool exists for the credential or it does not. Action
 * names here are the contract's; item 204 mints the real tools.
 */
export interface GraphGrantedActions {
  /** `submit_<port>`, one per output port. */
  submit: string[];
  /** `validate_<port>`, a dry run, one per output port. */
  validate: string[];
  /** The result status tool; always granted. */
  status: true;
  /** Output ports whose type has `items`, which `report_progress` may name. */
  reportProgress: string[];
  /** `read_artifact`: some input renders `on-demand`. */
  readArtifact: boolean;
  /** `ask_human`: only on nodes that opt in. */
  askHuman: boolean;
  orkestrator: { group: NativeAgentOrkestratorCapabilityGroup; tools: readonly string[] }[];
}

export function graphGrantedActions(input: GraphGrantedActionsInput): GraphGrantedActions {
  const outputs = input.outputs ?? [];
  return {
    submit: outputs.map((port) => port.name),
    validate: outputs.map((port) => port.name),
    status: true,
    reportProgress: outputs
      .filter((port) => input.typeHasItems(port.type))
      .map((port) => port.name),
    readArtifact: (input.inputs ?? []).some((port) => port.render === "on-demand"),
    askHuman: input.askHuman === true,
    orkestrator: NATIVE_AGENT_ORKESTRATOR_CAPABILITY_GROUPS.filter((group) =>
      input.orkestratorGroups.includes(group),
    ).map((group) => ({ group, tools: GRAPH_ORKESTRATOR_GROUP_TOOLS[group] })),
  };
}

/** Every action name the credential carries, sorted and unique. */
export function graphGrantedActionNames(actions: GraphGrantedActions): string[] {
  return [
    ...new Set([
      ...actions.submit.map((port) => `submit_${port}`),
      ...actions.validate.map((port) => `validate_${port}`),
      "get_workflow_result_status",
      ...(actions.reportProgress.length > 0 ? ["report_progress"] : []),
      ...(actions.readArtifact ? ["read_artifact"] : []),
      ...(actions.askHuman ? ["ask_human"] : []),
      ...actions.orkestrator.flatMap((entry) => entry.tools),
    ]),
  ].sort();
}

// ----------------------------------------------------- capability statement

const GROUP_LABELS: Readonly<Record<NativeAgentOrkestratorCapabilityGroup, string>> = Object.freeze(
  {
    "tickets.read": "reading tickets",
    "tickets.write": "creating and updating tickets",
    mail: "agent mail",
    artifacts: "transcript artifacts",
    schedules: "schedules",
  },
);

export interface GraphCapabilityStatementInput {
  compiled: CompiledGraphCapabilities;
  actions?: GraphGrantedActions;
  /** The tier on the provider this activation runs on, when known. */
  enforcement?: Pick<AgentEnforcementJudgement, "tier">;
}

/**
 * The capability statement in the node's locked system contract (item 105):
 * one plain sentence per limit, in a fixed order, so the same node always
 * gets the same text. It tells the agent what holds; the provider and the
 * guards are what hold it.
 */
export function describeGraphCapabilities(input: GraphCapabilityStatementInput): string {
  const { compiled, actions } = input;
  const denied = new Set<string>(compiled.denied);
  const lines: string[] = [];
  if (compiled.readOnly) {
    lines.push(
      "You may read the workspace but must not change it: you cannot create, edit or delete files.",
    );
    lines.push(
      denied.has("shell")
        ? "You have no shell."
        : "Your shell is read-only: run only commands that read, such as git diff, git log or git show.",
    );
  } else if (denied.has("file.write") || denied.has("file.patch")) {
    lines.push("You cannot create, edit or delete files with your file tools.");
    lines.push(
      denied.has("shell")
        ? "You have no shell."
        : denied.has("shell.mutate")
          ? "Your shell is read-only: run only commands that read."
          : "You may run commands, including builds and checks, but must leave tracked files as you found them.",
    );
  } else {
    lines.push("You may create, edit and delete files in the workspace.");
    if (denied.has("shell")) lines.push("You have no shell.");
    else if (denied.has("shell.mutate"))
      lines.push("Your shell is read-only: run only commands that read.");
  }
  if (denied.has("network")) {
    lines.push(
      compiled.webSearch
        ? "You have no network access except hosted web search; fetching web pages is off."
        : "You have no network access; hosted web search and web fetch are off.",
    );
  } else if (!compiled.webSearch) {
    lines.push("Hosted web search is off.");
  }
  lines.push(
    denied.has("git.commit") ? "You cannot create commits." : "You may commit your work locally.",
  );
  lines.push(
    "You cannot push or write to GitHub (pull requests, comments, labels); Orkestrator's system steps do that after you finish.",
  );
  if (denied.has("subagents")) lines.push("You cannot start sub-agents.");
  // A policy compiled before item 404 selects nothing; its denials still apply.
  const selected = compiled.policy.capabilityPolicy?.userMcpServers;
  if (selected) {
    lines.push(
      selected.length > 0
        ? `Of the user's own MCP servers you have only ${selected.join(", ")}.`
        : "You have none of the user's own MCP servers.",
    );
  } else {
    const servers = compiled.denied
      .map((capability) => nativeAgentMcpServer(capability))
      .filter((server): server is string => server !== undefined);
    if (servers.length > 0) lines.push(`You cannot use these MCP servers: ${servers.join(", ")}.`);
  }
  const groups = actions
    ? actions.orkestrator.map((entry) => entry.group)
    : compiled.orkestratorGroups;
  if (groups.length > 0) {
    lines.push(
      `You may use Orkestrator's tools for ${groups.map((group) => GROUP_LABELS[group]).join(", ")}.`,
    );
  }
  if (actions) {
    lines.push(
      actions.askHuman
        ? "You may ask the user a question with ask_human when you cannot continue without an answer; otherwise work unattended."
        : "Nobody is watching this step: do not ask the user questions; decide, and say what you assumed.",
    );
  }
  if (input.enforcement && input.enforcement.tier !== "enforced") {
    lines.push(
      "Some of these limits are not enforced by your provider. They are checked after you finish, and a violation fails this step.",
    );
  }
  const label = GRAPH_CAPABILITY_PROFILE_DEFINITIONS[compiled.profile].label;
  return [
    `Capabilities (${label.toLowerCase()} profile):`,
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}
