/**
 * The permission rules an execution policy means on OpenCode, in OpenCode's
 * `{ permission, pattern, action }` rule shape (last match wins).
 *
 * These builders date from the 1.x provider and are kept in that shape:
 * `permissions.ts` translates every rule set to 2.x terms (`bash` is `shell`,
 * `task` is `subagent`, `write`/`patch`/`apply_patch` are `edit`), so what a
 * policy means is decided here once. They cover the execution policy itself
 * (`openCodePermissionRules`, `effectiveOpenCodePolicy`), a reviewer's
 * constrained shell (`openCodeReviewPermissionRules`), workflow-result turn
 * grants (`openCodeWorkflowResultPermissionRules`) and a policy's selection of
 * the user's MCP servers (`openCodeUserMcpRules`, graphs item 404).
 */
import {
  appendNativeAgentPolicyNote,
  nativeAgentAllowsUserMcpServer,
  nativeAgentDeniedCapabilities,
  nativeAgentMcpServer,
  nativeAgentPolicyDeniesNetwork,
  nativeAgentPolicyDeniesWebSearch,
  nativeAgentRestrictsUserMcp,
  nativeAgentUserMcpGrant,
  withoutProviderSandbox,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import {
  GRAPH_ACTIVATION_EXTRA_TOOLS,
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_MCP_SERVER_NAME,
  REPORT_FINDING_TOOL_NAME,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  parseWorkflowResultTurn,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
import { COORDINATOR_CONTROL_TOOL_NAMES } from "@orkestrator/protocol/coordinator";
import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import { AGENT_GOAL_TOOL_NAMES } from "@orkestrator/protocol/native-agent-goal";
import { AGENT_AUTO_PIPELINE_TOOL_NAMES } from "@orkestrator/protocol/auto-pipeline-tool";
import {
  AGENT_SUBORK_TOOL_NAMES,
  SUBORK_RESULT_KIND,
  SUBORK_TOOL_NAME,
} from "@orkestrator/protocol/suborks";
import {
  ARTIFACT_TOOL_NAMES,
  ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
} from "@orkestrator/protocol/transcript-artifacts";
import type {
  ProviderPrepareDispatchOptions,
  ProviderSendOptions,
} from "../agent-provider-contract.js";
import { ORKESTRATOR_AGENT_MCP_SERVER_NAME } from "../agent-tools.js";

type PermissionAction = "allow" | "ask" | "deny";

/** One rule in OpenCode's original shape; `permissions.ts` translates it. */
export interface OpenCodePolicyRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

/**
 * OpenCode's permission ids for the tools a read-only coordinator may use.
 *
 * The base rule for a coordinator is `{"*": deny}`, so without an explicit
 * allow list here the session could not even read a file — which is the one
 * thing a coordinator is for. `skill` loads a discovered skill's SKILL.md and
 * lists the files beside it, and nothing more on 1.19.4: no hooks, tool grants
 * or inline shell, so it reads what `read` already could. Running a script a
 * skill ships still needs `bash`, which stays denied.
 */
const OPENCODE_READ_ONLY_PERMISSIONS = Object.freeze([
  "read",
  "list",
  "glob",
  "grep",
  "todoread",
  "todowrite",
  "task",
  "skill",
]);

/**
 * The coordinator's own Orkestrator tools, as OpenCode names MCP tools
 * (`<server>_<tool>`). Without these the `{"*": deny}` base refuses the
 * coordinator its mail and delegation tools, so it could neither read a
 * worker's report nor launch one. Listed by name, not `orkestrator_*`, so a
 * project `opencode.json` server whose name merely starts with "orkestrator"
 * gains nothing.
 */
const OPENCODE_COORDINATOR_TOOL_PERMISSIONS = Object.freeze(
  COORDINATOR_CONTROL_TOOL_NAMES.map((name) => `${ORKESTRATOR_AGENT_MCP_SERVER_NAME}_${name}`),
);

/**
 * A worker's always-allowed Orkestrator tools — mail and transcript artifacts,
 * which write only to Orkestrator's own stores — in OpenCode's
 * `<server>_<tool>` naming.
 */
const OPENCODE_AGENT_MAIL_PERMISSIONS = Object.freeze(
  [
    ...AGENT_MAIL_TOOL_NAMES,
    ...ARTIFACT_TOOL_NAMES,
    ...AGENT_GOAL_TOOL_NAMES,
    ...AGENT_SUBORK_TOOL_NAMES,
    ...AGENT_AUTO_PIPELINE_TOOL_NAMES,
  ].map((name) => `${ORKESTRATOR_AGENT_MCP_SERVER_NAME}_${name}`),
);

/**
 * OpenCode's page-fetch tool, denied by name whenever a policy denies `network`.
 *
 * A coordinator's `{"*": deny}` base already covers it, but that is a side
 * effect of the base rule, which an explicit `toolPolicy.allow` replaces. Named
 * denies hold whatever the base is, and a `task` subagent inherits every deny
 * rule of its parent session (OpenCode 1.19.0), so they reach subagents too.
 */
const OPENCODE_FETCH_PERMISSIONS = Object.freeze(["webfetch"]);

/**
 * OpenCode's hosted search tools: denied with the network unless the policy's
 * `allow` names `web.search`, and then allowed by name over a `*: deny` base.
 * Both send a query to a hosted search service and return its results.
 * `codesearch` is not a 1.19.0 tool; it is listed because earlier releases
 * shipped it as a hosted search, and a rule for an absent permission is inert.
 */
const OPENCODE_SEARCH_PERMISSIONS = Object.freeze(["websearch", "codesearch"]);

/** The mutating tools a reviewer is denied; its shell is re-opened by pattern instead. */
const OPENCODE_READ_ONLY_TURN_TOOLS: Readonly<Record<string, boolean>> = Object.freeze({
  write: false,
  edit: false,
  patch: false,
  apply_patch: false,
  bash: false,
  shell: false,
  task: false,
  todowrite: false,
  webfetch: false,
  websearch: false,
});

export function openCodeWorkflowResultToolId(toolName: string): string {
  return `${WORKFLOW_RESULT_MCP_SERVER_NAME}_${toolName}`;
}

const OPENCODE_WORKFLOW_RESULT_SUBMISSION_TOOLS = new Set(
  WORKFLOW_RESULT_KINDS.map(workflowResultToolName),
);

export function isOpenCodeWorkflowResultToolName(toolName: string): boolean {
  return OPENCODE_WORKFLOW_RESULT_SUBMISSION_TOOLS.has(toolName);
}

/**
 * The broker tools a turn that submits `selectedTool` may call. A reviewer's
 * turn also gets `report_finding`; the broker still answers only a live Multi
 * Review reviewer's own signed capability. A graph activation also gets the
 * extra tools its credential lists (`workflowResultExtraTools`).
 */
function openCodeWorkflowResultTurnToolNames(
  selectedTool: string,
  extraTools: readonly string[] = [],
): string[] {
  return [
    selectedTool,
    WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
    "get_workflow_result_status",
    ...AGENT_MAIL_TOOL_NAMES,
    ...(selectedTool === workflowResultToolName("review-report") ? [REPORT_FINDING_TOOL_NAME] : []),
    ...GRAPH_ACTIVATION_EXTRA_TOOLS.filter((tool) => extraTools.includes(tool)),
  ];
}

/**
 * Hide the persistent broker by default and expose only this turn's tools.
 * The graph activation extra tools are hidden like the rest unless the turn
 * lists them.
 */
export function openCodeWorkflowResultTurnTools(
  selectedTool?: string,
  extraTools?: readonly string[],
): Record<string, boolean> {
  const tools = Object.fromEntries(
    [
      ...WORKFLOW_RESULT_KINDS.map((kind) =>
        openCodeWorkflowResultToolId(workflowResultToolName(kind)),
      ),
      openCodeWorkflowResultToolId(WORKFLOW_RESULT_VALIDATION_TOOL_NAME),
      openCodeWorkflowResultToolId("get_workflow_result_status"),
      openCodeWorkflowResultToolId(REPORT_FINDING_TOOL_NAME),
      ...GRAPH_ACTIVATION_EXTRA_TOOLS.map(openCodeWorkflowResultToolId),
      ...AGENT_MAIL_TOOL_NAMES.map(openCodeWorkflowResultToolId),
    ].map((tool) => [tool, false]),
  );
  if (selectedTool) {
    for (const tool of openCodeWorkflowResultTurnToolNames(selectedTool, extraTools)) {
      tools[openCodeWorkflowResultToolId(tool)] = true;
    }
    // OpenCode's Orkestrator connection is environment-wide, so this is what
    // keeps a read-only workflow turn from starting suborks. A reviewer
    // session (a subork's) gets no tool map: its permission rules deny it.
    tools[OPENCODE_SUBORK_TOOL_ID] = false;
  }
  return tools;
}

/** `ask_agents` as OpenCode names it on the environment-wide Orkestrator connection. */
const OPENCODE_SUBORK_TOOL_ID = `${ORKESTRATOR_AGENT_MCP_SERVER_NAME}_${SUBORK_TOOL_NAME}`;

export function openCodeWorkflowResultPermissionRules(
  selectedTool: string,
  extraTools?: readonly string[],
) {
  return [
    ...openCodeWorkflowResultDenyPermissionRules(),
    // A subork elsewhere gets a result-only credential. Here the environment-wide
    // server's tools (tickets, artifacts, mail as the environment) are denied
    // instead; the allows below re-open this turn's own result-server tools.
    ...(selectedTool === workflowResultToolName(SUBORK_RESULT_KIND)
      ? [
          {
            permission: `${ORKESTRATOR_AGENT_MCP_SERVER_NAME}_*`,
            pattern: "*",
            action: "deny" as const,
          },
        ]
      : []),
    ...openCodeWorkflowResultTurnToolNames(selectedTool, extraTools).map((tool) => ({
      permission: openCodeWorkflowResultToolId(tool),
      pattern: "*",
      action: "allow" as const,
    })),
    // Depth 1. A subork runs in a reviewer session, which takes no per-turn
    // tool map, so this rule is what removes `ask_agents` from its tool list on
    // the environment-wide connection (a live OpenCode run showed it offered
    // without it). Only sessions Orkestrator runs itself take workflow turns,
    // and those cannot start suborks anyway, so the rule is not lifted at settle.
    { permission: OPENCODE_SUBORK_TOOL_ID, pattern: "*", action: "deny" as const },
  ];
}

/**
 * Why this turn's workflow-result fields cannot run on OpenCode, or null.
 *
 * The broker's tool list is fixed per environment, so a graph activation
 * submits every output through `submit_graph_output` with each slot's key:
 * a port's own `submit_<port>` does not exist there. Slots and extra tools
 * follow `parseWorkflowResultTurn`; the key, when the caller has one, must be
 * the first slot's. A turn without either is checked exactly as before.
 */
export function openCodeWorkflowResultTurnProblem(
  options: ProviderPrepareDispatchOptions & Pick<ProviderSendOptions, "workflowResultKey">,
): string | null {
  const { workflowResultTool: tool, workflowResultSlots: slots } = options;
  const extraTools = options.workflowResultExtraTools;
  if (tool === undefined) {
    return slots !== undefined || extraTools !== undefined
      ? "workflowResultSlots and workflowResultExtraTools require workflowResultTool"
      : null;
  }
  if (!isOpenCodeWorkflowResultToolName(tool)) {
    return "workflowResultTool must name a workflow result tool OpenCode's broker lists";
  }
  // A turn without slots or extra tools is checked exactly as before.
  if (slots === undefined && extraTools === undefined) return null;
  const graphOutput = workflowResultToolName("graph-output");
  if (
    slots !== undefined &&
    (tool !== graphOutput ||
      !Array.isArray(slots) ||
      slots.some((slot) => (slot as { tool?: unknown } | null)?.tool !== graphOutput))
  ) {
    return `OpenCode result slots must all use ${graphOutput}`;
  }
  const first: unknown = slots?.[0]?.resultKey;
  if (
    first !== undefined &&
    options.workflowResultKey !== undefined &&
    first !== options.workflowResultKey
  ) {
    return "workflowResultSlots must start with workflowResultKey";
  }
  // Prepare has no key of its own: the first slot names it.
  const key = options.workflowResultKey ?? first ?? "opencode-prepare";
  const parsed = parseWorkflowResultTurn(tool, key, slots, extraTools);
  return parsed.ok ? null : parsed.error;
}

export function openCodeWorkflowResultDenyPermissionRules() {
  return Object.keys(openCodeWorkflowResultTurnTools()).map((permission) => ({
    permission,
    pattern: "*",
    action: "deny" as const,
  }));
}

export function effectiveOpenCodePolicy(
  policy: NativeAgentExecutionPolicy,
): NativeAgentExecutionPolicy {
  // OpenCode resolves its session directory from the checkout's own
  // configuration and offers no way to opt out, so this axis cannot be
  // honoured. Reported rather than silently dropped: it is why OpenCode is
  // `provider-configured` and not `enforced`.
  const withResources = policy.projectResources
    ? policy
    : appendNativeAgentPolicyNote(
        { ...policy, projectResources: true },
        policy.id === "coordinator-read-only"
          ? "OpenCode always loads the checkout's project configuration, including any MCP servers it declares."
          : "OpenCode always reads project configuration for its session directory.",
      );
  // Nor does it have a sandbox: only the permission rules stand between its
  // commands and the network.
  return withoutProviderSandbox(withResources, {
    agent: "OpenCode",
    toolsetBlocksNetwork: openCodeRulesBlockNetwork(openCodePermissionRules(policy)),
  });
}

/**
 * Whether a rule set refuses every command and page fetch. OpenCode takes the
 * last rule that matches, which is why `openCodePermissionRules` puts denials
 * last. Only whole-permission rules count: a deny for one command pattern
 * (`git push *`) leaves every other command running.
 */
export function openCodeRulesBlockNetwork(
  rules: readonly { permission: string; pattern: string; action: string }[],
): boolean {
  const action = (permission: string) =>
    rules.findLast(
      (rule) => (rule.permission === permission || rule.permission === "*") && rule.pattern === "*",
    )?.action;
  return ["bash", "webfetch"].every((permission) => action(permission) === "deny");
}

/**
 * Command patterns each git or GitHub capability denies, for both of
 * OpenCode's shell permission ids. OpenCode matches globs against the command
 * as written, so `git -C x push` or a script still runs: these are advice the
 * provider applies, and the post-hoc guards hold the rest. `gh` is denied
 * whole for `github.write`, its reading commands included, because no glob
 * separates them from the writing ones.
 */
const OPENCODE_CAPABILITY_COMMAND_DENIALS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "git.commit": Object.freeze(["git commit", "git commit *"]),
    "git.push": Object.freeze(["git push", "git push *"]),
    "github.write": Object.freeze(["gh", "gh *"]),
  });

/**
 * Deny rules for the capabilities newer than the coordinator's vocabulary:
 * sub-agents (`task`, whose sub-agents inherit every deny of the parent), a
 * named MCP server (OpenCode registers its tools as `<server>_<tool>`, and a
 * permission key is a wildcard over the tool name), and the git and GitHub
 * command patterns above.
 */
function openCodeExtendedCapabilityDenials(policy: NativeAgentExecutionPolicy) {
  const rules: { permission: string; pattern: string; action: "deny" }[] = [];
  for (const capability of nativeAgentDeniedCapabilities(policy)) {
    if (capability === "subagents") {
      rules.push({ permission: "task", pattern: "*", action: "deny" });
      continue;
    }
    const server = nativeAgentMcpServer(capability);
    if (server) {
      // OpenCode replaces characters outside `[A-Za-z0-9_-]` in a server name
      // with `_` before prefixing its tools. Both spellings are denied; a
      // server whose name merely starts with this one's loses its tools too,
      // which is the safe direction.
      for (const prefix of new Set([server, server.replace(/[^A-Za-z0-9_-]/g, "_")])) {
        rules.push({ permission: `${prefix}_*`, pattern: "*", action: "deny" });
      }
      continue;
    }
    for (const pattern of OPENCODE_CAPABILITY_COMMAND_DENIALS[capability] ?? []) {
      for (const permission of ["bash", "shell"]) {
        rules.push({ permission, pattern, action: "deny" });
      }
    }
  }
  return rules;
}

export function openCodePermissionRules(
  policy: NativeAgentExecutionPolicy,
  options: {
    /**
     * A coordinator's research server tools, by the exact ids OpenCode
     * registered them under (`research-tools.ts`).
     */
    researchTools?: readonly string[];
    /**
     * The MCP servers the directory's instance lists, for a policy that
     * selects its user servers (graphs item 404, listed by `mcp.ts`).
     * Their rules come last.
     */
    configuredMcpServers?: readonly string[];
  } = {},
) {
  const action =
    policy.approvals === "auto-approve"
      ? ("allow" as const)
      : policy.approvals === "deny"
        ? ("deny" as const)
        : ("ask" as const);
  const coordinatorAllow =
    policy.id === "coordinator-read-only" && !policy.toolPolicy?.allow
      ? [
          ...OPENCODE_READ_ONLY_PERMISSIONS,
          ...OPENCODE_COORDINATOR_TOOL_PERMISSIONS,
          ...(nativeAgentPolicyDeniesWebSearch(policy) ? [] : OPENCODE_SEARCH_PERMISSIONS),
          ...(options.researchTools ?? []),
        ]
      : [];
  // A worker can always report back: its mail tools are allowed whatever the
  // ask/deny default. An explicit deny below still wins.
  const mailAllow =
    action === "allow" || policy.id === "coordinator-read-only"
      ? []
      : OPENCODE_AGENT_MAIL_PERMISSIONS;
  return [
    { permission: "*", pattern: "*", action },
    ...[...coordinatorAllow, ...mailAllow, ...(policy.toolPolicy?.allow ?? [])].map(
      (permission) => ({
        permission,
        pattern: "*",
        action: "allow" as const,
      }),
    ),
    // Last, so a deny always wins a collision with the read allowances above.
    ...[
      ...(policy.toolPolicy?.deny ?? []),
      ...(nativeAgentPolicyDeniesNetwork(policy) ? OPENCODE_FETCH_PERMISSIONS : []),
      ...(nativeAgentPolicyDeniesWebSearch(policy) ? OPENCODE_SEARCH_PERMISSIONS : []),
    ].map((permission) => ({
      permission,
      pattern: "*",
      action: "deny" as const,
    })),
    ...openCodeExtendedCapabilityDenials(policy),
    ...(options.configuredMcpServers
      ? openCodeUserMcpRules(policy, options.configuredMcpServers)
      : []),
  ];
}

/**
 * Whole commands a reviewer may run through OpenCode's shell tools.
 *
 * OpenCode patterns are simple globs, not a shell parser. The broad forms are
 * followed by mutation/injection denies below; last match wins in OpenCode.
 */
const OPENCODE_REVIEW_SHELL_ALLOW_PATTERNS = Object.freeze([
  "pwd",
  "ls",
  "ls *",
  "cat *",
  "head *",
  "tail *",
  "wc *",
  "stat *",
  "grep *",
  "rg *",
  "find *",
  "git status",
  "git status *",
  "git diff",
  "git diff *",
  "git log",
  "git log *",
  "git show",
  "git show *",
  "git blame *",
  "git cat-file *",
  "git describe",
  "git describe *",
  "git grep *",
  "git ls-files",
  "git ls-files *",
  "git ls-tree *",
  "git merge-base *",
  "git name-rev *",
  "git rev-list *",
  "git rev-parse *",
  "git shortlog",
  "git shortlog *",
  "git show-ref",
  "git show-ref *",
  "git whatchanged",
  "git whatchanged *",
]);

/** Later than the allows, so command chaining and write-capable flags lose. */
const OPENCODE_REVIEW_SHELL_DENY_PATTERNS = Object.freeze([
  "*&*",
  "*|*",
  "*;*",
  "*<*",
  "*>*",
  "*`*",
  "*$(*",
  "*\n*",
  "*\r*",
  "*--output *",
  "*--output=*",
  "*-o *",
  "*--ext-diff*",
  "*--textconv*",
  "*--filters*",
  "*--open-files-in-pager*",
  "*--pre*",
  "*--hostname-bin*",
  "*-delete*",
  "*-exec*",
  "*-execdir*",
  "*-fls*",
  "*-fprint*",
  "*-fprintf*",
  "*-ok*",
  "*-okdir*",
]);

function openCodeReviewShellAction(policy: NativeAgentExecutionPolicy): "allow" | "ask" | "deny" {
  const denied = new Set(policy.toolPolicy?.deny ?? []);
  // OpenCode has used both ids for the same capability. A deny under either
  // spelling is a deny under both, including the coordinator's `shell` rule.
  if (denied.has("*") || denied.has("bash") || denied.has("shell")) return "deny";
  const allowed = new Set(policy.toolPolicy?.allow ?? []);
  if (allowed.has("*") || allowed.has("bash") || allowed.has("shell")) return "allow";
  return policy.approvals === "auto-approve"
    ? "allow"
    : policy.approvals === "deny"
      ? "deny"
      : "ask";
}

/** Reviewers inspect evidence through constrained shell commands. */
export function openCodeReviewPermissionRules(policy: NativeAgentExecutionPolicy) {
  const shellAction = openCodeReviewShellAction(policy);
  return [
    ...openCodePermissionRules(policy),
    ...Object.keys(OPENCODE_READ_ONLY_TURN_TOOLS)
      .filter((permission) => permission !== "bash" && permission !== "shell")
      .map((permission) => ({ permission, pattern: "*", action: "deny" as const })),
    ...["bash", "shell"].flatMap((permission) => [
      { permission, pattern: "*", action: "deny" as const },
      ...(shellAction === "deny"
        ? []
        : OPENCODE_REVIEW_SHELL_ALLOW_PATTERNS.map((pattern) => ({
            permission,
            pattern,
            action: shellAction,
          }))),
      ...OPENCODE_REVIEW_SHELL_DENY_PATTERNS.map((pattern) => ({
        permission,
        pattern,
        action: "deny" as const,
      })),
    ]),
  ];
}

// ── user MCP servers (graphs item 404) ──────────────────────────────────────
//
// Every session of a location's OpenCode server sees every MCP server the
// location loaded: a server cannot be attached to one session or withheld from
// another. What a session does own is its permission rules. A policy that
// selects its user servers (`capabilityPolicy.userMcpServers`) therefore gets a
// deny rule for the tools (`<server>_*`) of every server the location lists
// (`mcp.ts`) outside the selection. The processes still run; the session cannot
// call them. A granted server keeps its tools, approved up front unless the
// policy asks, since the template's grant is the approval. A list that cannot
// be read refuses the session (`mcp.ts`): without it the rules would leave
// every server callable.

/** Servers Orkestrator posts itself; never a user's, never filtered. */
const RESERVED_OPENCODE_MCP_SERVERS: ReadonlySet<string> = new Set([
  ORKESTRATOR_AGENT_MCP_SERVER_NAME,
  "orkestrator-design",
  ORKESTRATOR_ARTIFACT_MCP_SERVER_NAME,
  WORKFLOW_RESULT_MCP_SERVER_NAME,
]);

/** Most listed servers a session's rules are computed over. */
export const MAX_OPENCODE_CONFIGURED_MCP_SERVERS = 256;

/**
 * The tool-name prefixes OpenCode gives a server: it replaces characters
 * outside `[A-Za-z0-9_-]` with `_` before prefixing its tools, so both
 * spellings are covered.
 */
function toolPrefixes(server: string): string[] {
  return [...new Set([server, server.replace(/[^A-Za-z0-9_-]/g, "_")])];
}

/**
 * Permission rules that leave a session exactly the user servers its policy
 * selects, given the servers the instance lists. Appended after every other
 * rule (OpenCode applies the last match):
 *
 * 1. deny `<server>_*` for every listed user server the policy does not allow;
 * 2. for every granted server, its own rule again (`allow`, or `ask` when the
 *    policy asks), so a denied server whose name prefixes it (`docs` before
 *    `docs_v2`) does not take its tools too;
 * 3. the policy's own `toolPolicy.deny` entries under a granted prefix again,
 *    so step 2 cannot re-open a tool the user denied by name.
 *
 * Empty for a policy that narrows nothing.
 */
export function openCodeUserMcpRules(
  policy: NativeAgentExecutionPolicy,
  configured: readonly string[],
): OpenCodePolicyRule[] {
  if (!nativeAgentRestrictsUserMcp(policy)) return [];
  const users = configured.filter((name) => !RESERVED_OPENCODE_MCP_SERVERS.has(name));
  const grant = new Set(nativeAgentUserMcpGrant(policy) ?? []);
  const rules: OpenCodePolicyRule[] = [];
  for (const server of users) {
    if (nativeAgentAllowsUserMcpServer(policy, server)) continue;
    for (const prefix of toolPrefixes(server)) {
      rules.push({ permission: `${prefix}_*`, pattern: "*", action: "deny" });
    }
  }
  if (rules.length === 0) return rules;
  const grantedPrefixes = users
    .filter((server) => grant.has(server) && nativeAgentAllowsUserMcpServer(policy, server))
    .flatMap(toolPrefixes);
  const grantAction: PermissionAction = policy.approvals === "ask" ? "ask" : "allow";
  for (const prefix of grantedPrefixes) {
    rules.push({ permission: `${prefix}_*`, pattern: "*", action: grantAction });
  }
  for (const tool of policy.toolPolicy?.deny ?? []) {
    if (grantedPrefixes.some((prefix) => tool.startsWith(`${prefix}_`))) {
      rules.push({ permission: tool, pattern: "*", action: "deny" });
    }
  }
  return rules;
}
