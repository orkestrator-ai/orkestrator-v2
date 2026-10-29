/**
 * Launching a saved graph template (item 214, plan P2.14, D6, D7, D17;
 * report §7.6). Every launch surface — the launch dialog, the designer's
 * Run, the CLI, the coordinator's Control MCP tools and scheduled jobs —
 * sends the same {@link GraphLaunchRequest} to one backend service, which
 * compiles the template for the real launch environment, binds the roles,
 * checks the bindings against each node's enforcement floor and creates the
 * run. What a picker offers comes from {@link GraphLaunchOptions}, built by
 * the same service, so the dialog never offers a binding the launch refuses.
 *
 * The pure helpers here are shared by the backend and the dialog:
 * {@link parseGraphLaunchRequest} (untrusted input to a request),
 * {@link graphRoleDefaultBindings} (item 108's reading of `defaultsFrom`),
 * {@link graphLaunchParams} (parameter values against their declarations)
 * and {@link graphLaunchCostEstimate} (the compile cost with the bound panel
 * sizes).
 *
 * Browser-safe: no Node or Bun imports.
 */
import { isAgentPlatform, type AgentPlatform } from "../agent-platforms.js";
import type { ActionDefaults, AgentActionDefault } from "../action-defaults.js";
import {
  REVIEW_LENS_INSTRUCTION_MAX_BYTES,
  REVIEW_LENS_LABEL_MAX_CHARS,
  type ReviewLens,
} from "../review-lens.js";
import type { GraphRoleProviderChoice } from "./agent-enforcement.js";
import type { GraphCompileDiagnostic } from "./compile-diagnostics.js";
import { GRAPH_TEMPLATE_BOUNDS, graphUtf8Bytes } from "./grammar.js";
import {
  parseGraphTemplateRef,
  type GraphTemplateRef,
  type GraphTemplateSummary,
} from "./library.js";
import type { CompiledGraphPlan, GraphCompileCost } from "./plan.js";
import { graphNodeBranches } from "./run-branches.js";
import {
  GRAPH_RUN_BOUNDS,
  GRAPH_RUN_LAUNCHERS,
  type GraphModelBinding,
  type GraphRunBindings,
  type GraphRunLauncher,
  type GraphRunStatus,
} from "./run-model.js";
import { GRAPH_RUN_ID_PATTERN } from "./run-identity.js";
import type {
  GraphEnvironmentKind,
  GraphParameter,
  GraphRole,
  GraphScalarValue,
} from "./template-model.js";

export const GRAPH_LAUNCH_BOUNDS = Object.freeze({
  /** Saved launch defaults per project, one per template (oldest dropped first). */
  maxSavedDefaultsPerProject: 64,
  /** An idempotency key (`requestId`). */
  maxRequestIdChars: 128,
  /** Serialized bytes of all run input values in one request. */
  maxInputBytes: 256 * 1024,
  /**
   * Runs that ended before they had an environment (failed provisioning) are
   * not removed by environment deletion; a sweep keeps at most this many per
   * project, newest first ...
   */
  maxEnvironmentlessRunsPerProject: 20,
  /** ... and none that ended longer ago than this. */
  environmentlessRunRetentionMs: 7 * 24 * 60 * 60 * 1_000,
});

/**
 * `code` on a refused launch, the same on every surface (the gateway, the
 * public CLI and the Control MCP tools forward it):
 *
 * - `invalid-request`: the request is malformed;
 * - `not-found`: the template, project, environment or ticket does not exist;
 * - `untrusted`: a project template not approved at its current digest;
 * - `engine-template`: a built-in that runs on its own engine (D5);
 * - `not-launchable`: the template has compile errors or pending acknowledgements;
 * - `invalid-binding`: a role binding misses a floor, a provider or a panel size;
 * - `invalid-launch`: parameters or inputs do not fit the plan;
 * - `conflict`: the `requestId` already launched a different run;
 * - `disabled`: graph runs are rolled back on this host.
 */
export const GRAPH_LAUNCH_ERROR_CODES = [
  "invalid-request",
  "not-found",
  "untrusted",
  "engine-template",
  "not-launchable",
  "invalid-binding",
  "invalid-launch",
  "conflict",
  "disabled",
] as const;
export type GraphLaunchErrorCode = (typeof GRAPH_LAUNCH_ERROR_CODES)[number];

// ------------------------------------------------------------ requests

/**
 * Where the run works (D7: one environment per run): a new worktree or
 * container the run provisions itself, or an existing environment of the
 * project.
 */
export type GraphLaunchEnvironment =
  { kind: "new"; create: GraphEnvironmentKind } | { kind: "existing"; environmentId: string };

export interface GraphLaunchTicket {
  /** A Kanban ticket of the project; it becomes the run's `ticket@1` input. */
  taskId: string;
  /** The `ticket@1` run input to fill; default the template's only one. */
  input?: string;
}

export interface GraphLaunchRequest {
  ref: GraphTemplateRef;
  projectId: string;
  environment: GraphLaunchEnvironment;
  /**
   * Role key → its model, or the panel's models. Roles left out take the
   * saved defaults for this template and project, else the settings defaults
   * ({@link graphRoleDefaultBindings}).
   */
  roles?: Record<string, GraphModelBinding | GraphModelBinding[]>;
  /** Parameter values; missing ones take the saved defaults, then the template's. */
  params?: Record<string, GraphScalarValue>;
  /** Value run inputs by name (reference inputs are not launchable yet). */
  inputs?: Record<string, unknown>;
  ticket?: GraphLaunchTicket;
  /** Save these roles, parameters and environment kind as the template's defaults. */
  saveDefaults?: boolean;
  /**
   * Idempotency key: the same key launches at most one run (the run id is
   * derived from it); repeating it returns that run.
   */
  requestId?: string;
}

/** What a launch surface knows about itself; never taken from the request body. */
export interface GraphLaunchOrigin {
  requestedBy: GraphRunLauncher;
  scheduleId?: string;
}

export interface GraphLaunchResult {
  runId: string;
  projectId: string;
  /** Absent while a run that creates its environment provisions it. */
  environmentId?: string;
  status: GraphRunStatus;
  template: { id: string; revision: number; name: string };
  /** The same `requestId` launched this run before; nothing new was created. */
  repeated: boolean;
}

// ------------------------------------------------------------ defaults

/** The launch choices saved per template per project. */
export interface GraphLaunchDefaults {
  roles: Record<string, GraphModelBinding | GraphModelBinding[]>;
  params: Record<string, GraphScalarValue>;
  /** The environment kind last chosen; an existing environment is not remembered. */
  environment?: "new-worktree" | "new-container" | "existing";
  updatedAt: string;
}

// ------------------------------------------------------------ options

export interface GraphLaunchProviderOption extends GraphRoleProviderChoice {
  /**
   * The provider can return the role's typed results (result tools or
   * structured output). Always true for a role whose nodes only produce
   * `workspace@1`.
   */
  structuredResults: boolean;
  /** `allowed` and `structuredResults`: the picker offers it. */
  available: boolean;
  /** Why it is not offered, for the picker's disabled entry. */
  unavailableReason?: string;
}

export interface GraphLaunchRoleOption {
  role: GraphRole;
  /** Agent nodes bound to the role, in plan order (empty: the role runs nothing). */
  nodes: string[];
  floor?: GraphRoleProviderChoice["tier"];
  /** Panel roles take a list of 1..`maxPanel` models. */
  panel: boolean;
  maxPanel: number;
  providers: GraphLaunchProviderOption[];
  /** The binding the dialog starts from: saved defaults, else settings defaults. */
  default: GraphModelBinding | GraphModelBinding[];
}

export interface GraphLaunchInputOption {
  name: string;
  type: string;
  label?: string;
  description?: string;
  required: boolean;
  /** A `ticket@1` input: a Kanban ticket can fill it. */
  ticket: boolean;
  /** A value input the launch can take; reference inputs cannot be launched yet. */
  launchable: boolean;
  /**
   * Left empty, a `workspace@1` input is filled at launch from the existing
   * environment's current branch and HEAD (a new environment has none yet).
   */
  autoFill?: "environment-head";
}

/** `graph_launch_options`: everything the launch dialog shows for one template. */
export interface GraphLaunchOptions {
  summary: GraphTemplateSummary;
  /** Trusted, not an engine template, compiles without errors or pending acknowledgements. */
  launchable: boolean;
  /** Why not, in one sentence. */
  blockedReason?: string;
  /** Error diagnostics, at most 20. */
  errors: GraphCompileDiagnostic[];
  roles: GraphLaunchRoleOption[];
  parameters: GraphParameter[];
  /** Saved values, else the template's defaults. */
  params: Record<string, GraphScalarValue>;
  inputs: GraphLaunchInputOption[];
  environment: {
    /** The template's workspace: `none` templates still run in one environment. */
    workspace: "environment" | "none";
    /** The template's `workspace.create`, the dialog's default for a new environment. */
    create?: GraphEnvironmentKind;
    /** The saved choice, else the template's. */
    default: "new-worktree" | "new-container" | "existing";
  };
  cost: GraphCompileCost | null;
  saved: GraphLaunchDefaults | null;
}

// ------------------------------------------------------------ parsing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,199}$/;
const TASK_ID_PATTERN = ENVIRONMENT_ID_PATTERN;
const INPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const SHORT_TEXT = GRAPH_RUN_BOUNDS.maxShortTextChars;

export class GraphLaunchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphLaunchRequestError";
  }
}

function fail(message: string): never {
  throw new GraphLaunchRequestError(message);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`${path} has unknown fields: ${unknown.slice(0, 5).join(", ")}`);
}

function parseLens(value: unknown, path: string): ReviewLens {
  if (!isRecord(value)) fail(`${path} must be an object with label and instruction`);
  onlyKeys(value, ["label", "instruction"], path);
  const label = typeof value.label === "string" ? value.label.trim() : "";
  const instruction = typeof value.instruction === "string" ? value.instruction.trim() : "";
  if (!label || Array.from(label).length > REVIEW_LENS_LABEL_MAX_CHARS) {
    fail(`${path}.label must be 1 to ${REVIEW_LENS_LABEL_MAX_CHARS} characters`);
  }
  if (!instruction || graphUtf8Bytes(instruction) > REVIEW_LENS_INSTRUCTION_MAX_BYTES) {
    fail(`${path}.instruction must be 1 to ${REVIEW_LENS_INSTRUCTION_MAX_BYTES} bytes`);
  }
  return { label, instruction };
}

/** One model binding from untrusted input. */
export function parseGraphModelBinding(value: unknown, path = "binding"): GraphModelBinding {
  if (!isRecord(value)) fail(`${path} must be an object with a platform`);
  onlyKeys(value, ["platform", "model", "reasoningEffort", "fastMode", "lens"], path);
  if (!isAgentPlatform(value.platform)) fail(`${path}.platform must be an agent platform`);
  const text = (field: "model" | "reasoningEffort"): string | undefined => {
    const raw = value[field];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string" || raw.length > SHORT_TEXT || /[\u0000-\u001f]/.test(raw)) {
      fail(`${path}.${field} must be a string of at most ${SHORT_TEXT} characters`);
    }
    return raw.trim() || undefined;
  };
  const model = text("model");
  const reasoningEffort = text("reasoningEffort");
  if (value.fastMode !== undefined && typeof value.fastMode !== "boolean") {
    fail(`${path}.fastMode must be a boolean`);
  }
  return {
    platform: value.platform,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(value.fastMode !== undefined ? { fastMode: value.fastMode as boolean } : {}),
    ...(value.lens !== undefined && value.lens !== null
      ? { lens: parseLens(value.lens, `${path}.lens`) }
      : {}),
  };
}

/** Role bindings from untrusted input (shape only; the plan decides what fits). */
export function parseGraphRoleBindings(
  value: unknown,
  path = "roles",
): Record<string, GraphModelBinding | GraphModelBinding[]> {
  if (!isRecord(value)) fail(`${path} must be an object of role bindings`);
  const entries = Object.entries(value);
  if (entries.length > GRAPH_RUN_BOUNDS.maxRoleBindings) {
    fail(`${path} binds more than ${GRAPH_RUN_BOUNDS.maxRoleBindings} roles`);
  }
  const roles: Record<string, GraphModelBinding | GraphModelBinding[]> = {};
  for (const [role, binding] of entries) {
    if (!INPUT_NAME_PATTERN.test(role)) fail(`${path} has an invalid role key`);
    if (Array.isArray(binding)) {
      if (binding.length === 0 || binding.length > GRAPH_RUN_BOUNDS.maxPanelBindings) {
        fail(`${path}.${role} must list 1 to ${GRAPH_RUN_BOUNDS.maxPanelBindings} models`);
      }
      roles[role] = binding.map((entry, index) =>
        parseGraphModelBinding(entry, `${path}.${role}[${index}]`),
      );
    } else {
      roles[role] = parseGraphModelBinding(binding, `${path}.${role}`);
    }
  }
  return roles;
}

function parseParams(value: unknown): Record<string, GraphScalarValue> {
  if (!isRecord(value)) fail("params must be an object of parameter values");
  const entries = Object.entries(value);
  if (entries.length > GRAPH_RUN_BOUNDS.maxParams) {
    fail(`params sets more than ${GRAPH_RUN_BOUNDS.maxParams} values`);
  }
  const params: Record<string, GraphScalarValue> = {};
  for (const [key, entry] of entries) {
    if (!INPUT_NAME_PATTERN.test(key)) fail("params has an invalid parameter key");
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      fail(`params.${key} must be a string, number, boolean or null`);
    }
    params[key] = entry;
  }
  return params;
}

function parseEnvironment(value: unknown): GraphLaunchEnvironment {
  if (!isRecord(value)) fail("environment must be { kind: new, create } or { kind: existing }");
  if (value.kind === "new") {
    onlyKeys(value, ["kind", "create"], "environment");
    if (value.create !== "worktree" && value.create !== "container") {
      fail("environment.create must be worktree or container");
    }
    return { kind: "new", create: value.create };
  }
  if (value.kind === "existing") {
    onlyKeys(value, ["kind", "environmentId"], "environment");
    if (
      typeof value.environmentId !== "string" ||
      !ENVIRONMENT_ID_PATTERN.test(value.environmentId)
    ) {
      fail("environment.environmentId must be an environment id");
    }
    return { kind: "existing", environmentId: value.environmentId };
  }
  return fail("environment.kind must be new or existing");
}

/**
 * A launch request from untrusted input (a command, a public action, an MCP
 * tool, a stored schedule). Throws {@link GraphLaunchRequestError} naming
 * the first problem. Shape only: the service checks it against the plan.
 */
export function parseGraphLaunchRequest(value: unknown): GraphLaunchRequest {
  if (!isRecord(value)) fail("The launch request must be an object");
  onlyKeys(
    value,
    [
      "ref",
      "projectId",
      "environment",
      "roles",
      "params",
      "inputs",
      "ticket",
      "saveDefaults",
      "requestId",
    ],
    "The launch request",
  );
  const ref = parseGraphTemplateRef(value.ref);
  if ("error" in ref) fail(ref.error);
  if (typeof value.projectId !== "string" || !ENVIRONMENT_ID_PATTERN.test(value.projectId)) {
    fail("projectId must be a project id");
  }
  if (ref.scope === "project" && ref.projectId !== value.projectId) {
    fail("A project template launches in its own project");
  }
  const request: GraphLaunchRequest = {
    ref,
    projectId: value.projectId,
    environment: parseEnvironment(value.environment),
  };
  if (value.roles !== undefined && value.roles !== null) {
    request.roles = parseGraphRoleBindings(value.roles);
  }
  if (value.params !== undefined && value.params !== null) {
    request.params = parseParams(value.params);
  }
  if (value.inputs !== undefined && value.inputs !== null) {
    if (!isRecord(value.inputs)) fail("inputs must be an object of run input values");
    const names = Object.keys(value.inputs);
    if (names.length > GRAPH_RUN_BOUNDS.maxInputs) {
      fail(`inputs sets more than ${GRAPH_RUN_BOUNDS.maxInputs} values`);
    }
    if (names.some((name) => !INPUT_NAME_PATTERN.test(name))) fail("inputs has an invalid name");
    let bytes: number;
    try {
      bytes = graphUtf8Bytes(JSON.stringify(value.inputs));
    } catch {
      return fail("inputs must be JSON values");
    }
    if (bytes > GRAPH_LAUNCH_BOUNDS.maxInputBytes) {
      fail(`inputs exceed ${GRAPH_LAUNCH_BOUNDS.maxInputBytes} bytes`);
    }
    request.inputs = structuredClone(value.inputs);
  }
  if (value.ticket !== undefined && value.ticket !== null) {
    if (!isRecord(value.ticket)) fail("ticket must be { taskId, input? }");
    onlyKeys(value.ticket, ["taskId", "input"], "ticket");
    if (typeof value.ticket.taskId !== "string" || !TASK_ID_PATTERN.test(value.ticket.taskId)) {
      fail("ticket.taskId must be a ticket id");
    }
    if (
      value.ticket.input !== undefined &&
      (typeof value.ticket.input !== "string" || !INPUT_NAME_PATTERN.test(value.ticket.input))
    ) {
      fail("ticket.input must be a run input name");
    }
    request.ticket = {
      taskId: value.ticket.taskId,
      ...(typeof value.ticket.input === "string" ? { input: value.ticket.input } : {}),
    };
  }
  if (value.saveDefaults !== undefined) {
    if (typeof value.saveDefaults !== "boolean") fail("saveDefaults must be a boolean");
    request.saveDefaults = value.saveDefaults;
  }
  if (value.requestId !== undefined && value.requestId !== null) {
    if (
      typeof value.requestId !== "string" ||
      value.requestId.length === 0 ||
      value.requestId.length > GRAPH_LAUNCH_BOUNDS.maxRequestIdChars ||
      /[\u0000-\u001f]/.test(value.requestId)
    ) {
      fail(`requestId must be 1 to ${GRAPH_LAUNCH_BOUNDS.maxRequestIdChars} characters`);
    }
    request.requestId = value.requestId;
  }
  return request;
}

export function isGraphRunLauncher(value: unknown): value is GraphRunLauncher {
  return GRAPH_RUN_LAUNCHERS.includes(value as GraphRunLauncher);
}

/** True when `id` is a run id (`GRAPH_RUN_ID_PATTERN`). */
export function isGraphLaunchRunId(id: string): boolean {
  return GRAPH_RUN_ID_PATTERN.test(id);
}

// ------------------------------------------------------------ role defaults

/** The settings a launch's role defaults come from (resolved through the tiers). */
export interface GraphRoleDefaultSettings {
  actionDefaults: ActionDefaults;
  /** Reviewer 3 onward (`MultiReviewAgentSettings.additionalReviewers`, already cut to the count). */
  additionalReviewers: ReadonlyArray<AgentActionDefault | null>;
  /** Saved reviewer lenses from Reviewer 1; applied to a panel that reads `additionalReviewers`. */
  reviewerLenses?: ReadonlyArray<ReviewLens | null>;
  /** The app's default agent. */
  defaultAgent: AgentPlatform;
  enabledAgents: readonly AgentPlatform[];
}

function usable(
  entry: AgentActionDefault | null | undefined,
  enabled: readonly AgentPlatform[],
): entry is AgentActionDefault & { platform: AgentPlatform } {
  return !!entry?.platform && enabled.includes(entry.platform);
}

function bindingOf(entry: AgentActionDefault & { platform: AgentPlatform }): GraphModelBinding {
  return {
    platform: entry.platform,
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
    ...(entry.fastMode !== undefined ? { fastMode: entry.fastMode } : {}),
  };
}

/**
 * Item 108's reading of `defaultsFrom`. A one-model role takes the first
 * action key with a usable saved platform (set and enabled), else the app's
 * default agent. A panel takes one position per action key (an unset key
 * takes the first key's binding), then one per `additionalReviewers` entry
 * (an unset entry takes the first key's). A panel without `defaultsFrom` is
 * one position on the default agent. A panel reading `additionalReviewers`
 * (the reviewer panel) also takes the saved reviewer lenses by position.
 */
export function graphRoleDefaultBindings(
  roles: readonly GraphRole[],
  settings: GraphRoleDefaultSettings,
): Record<string, GraphModelBinding | GraphModelBinding[]> {
  const enabled = settings.enabledAgents;
  const fallback: GraphModelBinding = { platform: settings.defaultAgent };
  const result: Record<string, GraphModelBinding | GraphModelBinding[]> = {};
  for (const role of roles) {
    const sources = role.defaultsFrom ?? [];
    const keys = sources.filter((source) => source !== "additionalReviewers");
    if (role.multiplicity === "one") {
      const first = keys
        .map((key) => settings.actionDefaults[key])
        .find((entry) => usable(entry, enabled));
      result[role.key] = first ? bindingOf(first) : { ...fallback };
      continue;
    }
    const firstEntry = keys.length > 0 ? settings.actionDefaults[keys[0]!] : undefined;
    const firstBinding = usable(firstEntry, enabled) ? bindingOf(firstEntry) : fallback;
    const members: GraphModelBinding[] = keys.map((key) => {
      const entry = settings.actionDefaults[key];
      return usable(entry, enabled) ? bindingOf(entry) : { ...firstBinding };
    });
    const readsAdditional = sources.includes("additionalReviewers");
    if (readsAdditional) {
      for (const entry of settings.additionalReviewers) {
        members.push(usable(entry, enabled) ? bindingOf(entry) : { ...firstBinding });
      }
    }
    if (members.length === 0) members.push({ ...fallback });
    const max = Math.min(
      role.maxPanel ?? GRAPH_TEMPLATE_BOUNDS.maxBranches,
      GRAPH_TEMPLATE_BOUNDS.maxBranches,
    );
    const panel = members.slice(0, Math.max(1, max));
    if (readsAdditional && settings.reviewerLenses) {
      panel.forEach((member, index) => {
        const lens = settings.reviewerLenses?.[index];
        if (lens) member.lens = { label: lens.label, instruction: lens.instruction };
      });
    }
    result[role.key] = panel;
  }
  return result;
}

// ------------------------------------------------------------ parameters

export interface GraphLaunchParamsResult {
  /** Every declared parameter with a value (given, saved or the template's default). */
  params: Record<string, GraphScalarValue>;
  /** One message per problem; empty when the values fit. */
  issues: string[];
}

/**
 * Parameter values for a launch: `given` first, then `saved`, then each
 * declaration's default. A parameter without any value, an unknown key and a
 * value outside its declaration are issues. Saved values that no longer fit
 * (the template changed) are dropped silently in favour of the default.
 */
export function graphLaunchParams(
  parameters: readonly GraphParameter[],
  given: Readonly<Record<string, GraphScalarValue>> = {},
  saved: Readonly<Record<string, GraphScalarValue>> = {},
): GraphLaunchParamsResult {
  const issues: string[] = [];
  const declared = new Map(parameters.map((parameter) => [parameter.key, parameter]));
  for (const key of Object.keys(given)) {
    if (!declared.has(key)) issues.push(`The template has no parameter ${key}`);
  }
  const params: Record<string, GraphScalarValue> = {};
  for (const parameter of parameters) {
    if (given[parameter.key] !== undefined) {
      const problem = graphParamValueProblem(parameter, given[parameter.key]!);
      if (problem) issues.push(problem);
      else params[parameter.key] = given[parameter.key]!;
      continue;
    }
    const kept = saved[parameter.key];
    if (kept !== undefined && !graphParamValueProblem(parameter, kept)) {
      params[parameter.key] = kept;
      continue;
    }
    if (parameter.default !== undefined) {
      params[parameter.key] = parameter.default;
      continue;
    }
    issues.push(`The parameter ${parameter.key} needs a value`);
  }
  return { params, issues };
}

/** Why `value` does not fit `parameter`, or null. */
export function graphParamValueProblem(
  parameter: GraphParameter,
  value: GraphScalarValue,
): string | null {
  const name = `The parameter ${parameter.key}`;
  switch (parameter.type) {
    case "boolean":
      return typeof value === "boolean" ? null : `${name} must be true or false`;
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${name} must be a number`;
      if (parameter.type === "integer" && !Number.isSafeInteger(value)) {
        return `${name} must be a whole number`;
      }
      if (parameter.min !== undefined && value < parameter.min) {
        return `${name} must be at least ${parameter.min}`;
      }
      if (parameter.max !== undefined && value > parameter.max) {
        return `${name} must be at most ${parameter.max}`;
      }
      return null;
    }
    case "string": {
      if (typeof value !== "string") return `${name} must be text`;
      const max = Math.min(
        parameter.maxBytes ?? GRAPH_TEMPLATE_BOUNDS.maxStringParameterBytes,
        GRAPH_TEMPLATE_BOUNDS.maxStringParameterBytes,
      );
      return graphUtf8Bytes(value) > max ? `${name} must be at most ${max} bytes` : null;
    }
    case "enum":
      return typeof value === "string" && parameter.options.includes(value)
        ? null
        : `${name} must be one of ${parameter.options.join(", ")}`;
  }
}

// ------------------------------------------------------------ inputs and cost

/** The `ticket@1` run input a ticket fills: `input` when given, else the only one. */
export function graphTicketInputName(
  plan: Pick<CompiledGraphPlan, "inputs">,
  input?: string,
): string | null {
  const tickets = plan.inputs.filter((entry) => entry.type === "ticket@1");
  if (input !== undefined) return tickets.some((entry) => entry.name === input) ? input : null;
  return tickets.length === 1 ? tickets[0]!.name : null;
}

/** The dialog's environment choice as a request environment (`existing` needs an id). */
export function graphLaunchEnvironmentChoice(
  choice: "new-worktree" | "new-container" | "existing",
  environmentId?: string,
): GraphLaunchEnvironment | null {
  if (choice === "new-worktree") return { kind: "new", create: "worktree" };
  if (choice === "new-container") return { kind: "new", create: "container" };
  return environmentId ? { kind: "existing", environmentId } : null;
}

/** The saved form of a request environment. */
export function graphLaunchEnvironmentKey(
  environment: GraphLaunchEnvironment,
): "new-worktree" | "new-container" | "existing" {
  return environment.kind === "existing" ? "existing" : `new-${environment.create}`;
}

/**
 * The compile cost with the bound panel sizes: each node's sessions per
 * branch times the branches its bindings give it. Nodes whose branch count
 * does not depend on bindings keep the compile figures.
 */
export function graphLaunchCostEstimate(
  plan: Pick<CompiledGraphPlan, "nodes" | "cost">,
  roles: GraphRunBindings["roles"],
): { agentSessions: { best: number; worst: number }; peakParallelism: number } {
  let best = 0;
  let worst = 0;
  let peak = plan.cost.peakParallelism;
  for (const entry of plan.cost.nodes) {
    const node = plan.nodes.find((candidate) => candidate.id === entry.nodeId);
    let branches: number | null = null;
    if (node && node.kind === "agent" && node.replicate) {
      try {
        branches = graphNodeBranches(node, roles)?.length ?? null;
      } catch {
        branches = null;
      }
    }
    if (branches === null) {
      best += entry.agentSessions.best;
      worst += entry.agentSessions.worst;
      continue;
    }
    const perBest = entry.agentSessions.best / Math.max(1, entry.branches.min);
    const perWorst = entry.agentSessions.worst / Math.max(1, entry.branches.max);
    best += Math.ceil(perBest * branches);
    worst += Math.ceil(perWorst * branches);
    if (entry.agentSessions.worst > 0) peak = Math.max(peak, branches);
  }
  return { agentSessions: { best, worst }, peakParallelism: peak };
}
