/**
 * Session permission rules for OpenCode 2.x sessions
 * (docs/todo/agent-engines/0008-opencode-v2.md, phase 5; task 4: the read-only
 * per-prompt tools mask moves to session permissions).
 *
 * 2.x has no per-prompt tool mask. What a session may do is its agent's rules
 * followed by the session's own `permissions` (`PATCH /api/session/:id`), and
 * the last rule that matches wins. A tool whose action is denied for every
 * resource is also left out of the model's tool list, so a denied tool is
 * neither offered nor runnable (verified on 2.2.6).
 *
 * Every rule set is built from the same 1.x rule builders (execution policy,
 * reviewer shell, workflow-result grants) and translated, so the two lines
 * cannot drift on what a policy means. 2.x renamed three permission ids:
 * `bash` is `shell`, `task` is `subagent`, and `write`/`patch`/`apply_patch`
 * are all `edit`.
 *
 * Orkestrator's MCP servers are location-scoped on 2.x: every session of the
 * environment's server sees every registered server. Each session's rules
 * therefore deny every Orkestrator server except its own tab's
 * (`orkestrator_tab_<id>`), design (`orkestrator_design_<id>`) and artifact
 * (`orkestrator_artifacts_<id>`) servers, and the workflow-result broker
 * except during a turn that owns a result tool.
 */
import { createHash } from "node:crypto";
import { WORKFLOW_RESULT_MCP_SERVER_NAME } from "@orkestrator/protocol/workflow-results";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { SUBORK_TOOL_NAME } from "@orkestrator/protocol/suborks";
import {
  effectiveOpenCodePolicy,
  openCodePermissionRules,
  openCodeReviewPermissionRules,
  openCodeWorkflowResultPermissionRules,
} from "../opencode-provider-helpers.js";
import type { OpenCode2PermissionRule } from "./types.js";

/** Prefix of every per-tab Orkestrator MCP server on a 2.x server. */
export const OPENCODE2_TAB_MCP_PREFIX = "orkestrator_tab_";
/** Prefix of every per-session design server (`/design-mcp`, the tab's credential). */
export const OPENCODE2_DESIGN_MCP_PREFIX = "orkestrator_design_";
/** Prefix of every per-session artifact-only server (`/artifact-mcp`, the turn's grant). */
export const OPENCODE2_ARTIFACTS_MCP_PREFIX = "orkestrator_artifacts_";
/** The per-session Orkestrator server kinds, each confined to its own session. */
export const OPENCODE2_SESSION_MCP_PREFIXES = [
  OPENCODE2_TAB_MCP_PREFIX,
  OPENCODE2_DESIGN_MCP_PREFIX,
  OPENCODE2_ARTIFACTS_MCP_PREFIX,
] as const;
export type OpenCode2SessionMcpPrefix = (typeof OPENCODE2_SESSION_MCP_PREFIXES)[number];
/** Most rules a session is given; a ruleset past it is refused rather than truncated. */
export const MAX_OPENCODE2_SESSION_RULES = 512;

type LegacyRule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" };

/** 1.x permission ids that 2.x renamed. */
const RENAMED: Readonly<Record<string, string>> = Object.freeze({
  bash: "shell",
  task: "subagent",
  write: "edit",
  patch: "edit",
  apply_patch: "edit",
});

/** One 1.x rule list in 2.x terms, dropping the duplicates the renames create. */
export function toOpenCode2Rules(rules: readonly LegacyRule[]): OpenCode2PermissionRule[] {
  const result: OpenCode2PermissionRule[] = [];
  for (const rule of rules) {
    const next: OpenCode2PermissionRule = {
      action: RENAMED[rule.permission] ?? rule.permission,
      resource: rule.pattern,
      effect: rule.action,
    };
    const previous = result.at(-1);
    if (
      previous &&
      previous.action === next.action &&
      previous.resource === next.resource &&
      previous.effect === next.effect
    ) {
      continue;
    }
    result.push(next);
  }
  return result;
}

/**
 * The mutation boundary of a read-only turn: every 2.2.6 tool that writes a
 * file, runs a command, starts a sub-agent (a child session takes none of its
 * parent's session rules), reaches the network, or acts on OpenCode itself
 * (the `opencode_*` worktree, schedule, artifact and session tools).
 */
export const OPENCODE2_READ_ONLY_RULES: readonly OpenCode2PermissionRule[] = Object.freeze(
  [
    "edit",
    "shell",
    "subagent",
    "todowrite",
    "webfetch",
    "websearch",
    "experimental_image_generate",
    "opencode_*",
  ].map((action) => ({ action, resource: "*", effect: "deny" as const })),
);

/** The tool-name namespace 2.x gives a server (`[^A-Za-z0-9_-]` becomes `_`). */
export function openCode2McpNamespace(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** One session's server of one kind: stable for the session, never shared. */
export function openCode2SessionMcpServer(
  prefix: OpenCode2SessionMcpPrefix,
  sessionId: string,
): string {
  return `${prefix}${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
}

/** The MCP server name of one session's tab connection: stable for the session, never shared. */
export function openCode2TabMcpServer(sessionId: string): string {
  return openCode2SessionMcpServer(OPENCODE2_TAB_MCP_PREFIX, sessionId);
}

/** Whether a server name is one Orkestrator registers itself (never a user's). */
export function isOrkestratorOpenCode2McpServer(name: string): boolean {
  return name === WORKFLOW_RESULT_MCP_SERVER_NAME || name.startsWith("orkestrator");
}

/**
 * Every session's per-session Orkestrator servers (tab, design, artifacts)
 * and the workflow-result tools denied: what a session is created with.
 */
function openCode2IsolationDenies(): OpenCode2PermissionRule[] {
  return [
    ...OPENCODE2_SESSION_MCP_PREFIXES.map((prefix) => ({
      action: `${prefix}*`,
      resource: "*",
      effect: "deny" as const,
    })),
    {
      action: `${openCode2McpNamespace(WORKFLOW_RESULT_MCP_SERVER_NAME)}_*`,
      resource: "*",
      effect: "deny",
    },
  ];
}

/**
 * Last in every session's steady rules: no other session's Orkestrator tools
 * and no workflow-result tools, then this session's own servers back (its tab
 * server last).
 */
export function openCode2IsolationRules(sessionId: string): OpenCode2PermissionRule[] {
  return [
    ...openCode2IsolationDenies(),
    ...(
      [
        OPENCODE2_DESIGN_MCP_PREFIX,
        OPENCODE2_ARTIFACTS_MCP_PREFIX,
        OPENCODE2_TAB_MCP_PREFIX,
      ] as const
    ).map((prefix) => ({
      action: `${openCode2SessionMcpServer(prefix, sessionId)}_*`,
      resource: "*",
      effect: "allow" as const,
    })),
  ];
}

/** The base rules of a session created with a backend execution policy. */
export function openCode2PolicyRules(
  policy: NativeAgentExecutionPolicy | undefined,
): OpenCode2PermissionRule[] {
  return policy ? toOpenCode2Rules(openCodePermissionRules(effectiveOpenCodePolicy(policy))) : [];
}

/** A reviewer's constrained shell for one read-only turn, in place of the base rules. */
export function openCode2ReviewRules(
  policy: NativeAgentExecutionPolicy,
): OpenCode2PermissionRule[] {
  return toOpenCode2Rules(openCodeReviewPermissionRules(effectiveOpenCodePolicy(policy)));
}

/**
 * The grants of a turn that submits `selectedTool`: the broker's tools stay
 * denied except this turn's, and `ask_agents` is denied on the tab server
 * (1.x denies it on its environment-wide server). 1.x's rule for a subork's
 * result turn denies `orkestrator_*`, which on 2.x also covers the tab server.
 */
export function openCode2WorkflowTurnRules(
  selectedTool: string,
  extraTools?: readonly string[],
): OpenCode2PermissionRule[] {
  return [
    ...toOpenCode2Rules(openCodeWorkflowResultPermissionRules(selectedTool, extraTools)),
    { action: `${OPENCODE2_TAB_MCP_PREFIX}*_${SUBORK_TOOL_NAME}`, resource: "*", effect: "deny" },
  ];
}

export interface OpenCode2TurnRuleInput {
  readOnly?: boolean;
  /** Set only when the session's durable reviewer marker allows it. */
  reviewPolicy?: NativeAgentExecutionPolicy;
  workflowResultTool?: string;
  workflowResultExtraTools?: readonly string[];
}

/**
 * What a session is created with, before its id is known: the base, then
 * every Orkestrator server denied. Its first turn adds its own tab server.
 */
export function openCode2CreateRules(
  base: readonly OpenCode2PermissionRule[],
): OpenCode2PermissionRule[] {
  return bounded([...base, ...openCode2IsolationDenies()]);
}

/** What a session runs with between turns. */
export function openCode2SteadyRules(
  base: readonly OpenCode2PermissionRule[],
  sessionId: string,
): OpenCode2PermissionRule[] {
  return bounded([...base, ...openCode2IsolationRules(sessionId)]);
}

/**
 * What a session runs one turn with. A reviewer's rules replace the base
 * (they start from the same policy); a plain read-only turn appends the
 * mutation denies to it. Isolation follows both, so neither can re-open
 * another tab's server, and the turn's own result grants come last.
 */
export function openCode2TurnRules(
  base: readonly OpenCode2PermissionRule[],
  sessionId: string,
  turn: OpenCode2TurnRuleInput,
): OpenCode2PermissionRule[] {
  const review = turn.readOnly && turn.reviewPolicy ? openCode2ReviewRules(turn.reviewPolicy) : [];
  return bounded([
    ...(review.length > 0 ? review : base),
    ...(turn.readOnly && review.length === 0 ? OPENCODE2_READ_ONLY_RULES : []),
    ...openCode2IsolationRules(sessionId),
    ...(turn.workflowResultTool
      ? openCode2WorkflowTurnRules(turn.workflowResultTool, turn.workflowResultExtraTools)
      : []),
  ]);
}

/** Whether a turn changes anything over the steady rules. */
export function openCode2TurnNeedsGrant(turn: OpenCode2TurnRuleInput): boolean {
  return turn.readOnly === true || turn.workflowResultTool !== undefined;
}

/** Valid stored rules, or undefined when anything in them is malformed. */
export function readOpenCode2Rules(value: unknown): OpenCode2PermissionRule[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OPENCODE2_SESSION_RULES) return undefined;
  const rules: OpenCode2PermissionRule[] = [];
  for (const rule of value) {
    if (
      !rule ||
      typeof rule !== "object" ||
      typeof (rule as OpenCode2PermissionRule).action !== "string" ||
      typeof (rule as OpenCode2PermissionRule).resource !== "string" ||
      !["allow", "deny", "ask"].includes((rule as OpenCode2PermissionRule).effect)
    ) {
      return undefined;
    }
    const { action, resource, effect } = rule as OpenCode2PermissionRule;
    rules.push({ action, resource, effect });
  }
  return rules;
}

export function sameOpenCode2Rules(
  left: readonly OpenCode2PermissionRule[] | undefined,
  right: readonly OpenCode2PermissionRule[],
): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every(
    (rule, index) =>
      rule.action === right[index]!.action &&
      rule.resource === right[index]!.resource &&
      rule.effect === right[index]!.effect,
  );
}

function bounded(rules: OpenCode2PermissionRule[]): OpenCode2PermissionRule[] {
  if (rules.length > MAX_OPENCODE2_SESSION_RULES) {
    throw new Error(
      `An OpenCode 2 session cannot hold more than ${MAX_OPENCODE2_SESSION_RULES} rules`,
    );
  }
  return rules;
}
