import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  graphLaunchEnvironmentChoice,
  graphParamValueProblem,
  type GraphLaunchInputOption,
  type GraphLaunchOptions,
  type GraphLaunchProviderOption,
  type GraphLaunchRequest,
  type GraphLaunchRoleOption,
} from "@orkestrator/protocol/graphs/launch";
import type { GraphTemplateRef, GraphTemplateSummary } from "@orkestrator/protocol/graphs/library";
import type { GraphModelBinding } from "@orkestrator/protocol/graphs/run";
import type { GraphParameter, GraphScalarValue } from "@orkestrator/protocol/graphs/template";
import { normalizeReviewLens, type ReviewLens } from "@orkestrator/protocol/review-lens";
import { reviewLensDraftError } from "@/components/review/ReviewLensField";

/**
 * The launch dialog's state and the pure rules over it (item 214): the draft
 * the dialog edits, prefilled from `graph_launch_options` (saved defaults,
 * else the settings defaults), the providers each role may offer, the
 * problems that keep Launch disabled, the request it sends and a cost
 * estimate with the panel sizes the user chose. Kept free of React so every
 * rule is testable on its own.
 */

export type GraphLaunchEnvironmentKey = GraphLaunchOptions["environment"]["default"];

export interface GraphLaunchMemberDraft {
  /** Stable React key; never sent. */
  key: string;
  binding: GraphModelBinding;
}

export interface GraphLaunchDraft {
  /** Role key → its members (one entry for a one-model role). */
  roles: Record<string, GraphLaunchMemberDraft[]>;
  /** Parameter key → the control's value (numbers stay text until launch). */
  params: Record<string, string | boolean>;
  /** Value input name → JSON text. */
  inputs: Record<string, string>;
  /** The Kanban ticket filling the template's ticket input. */
  ticketTaskId: string | null;
  environment: GraphLaunchEnvironmentKey;
  /** The existing environment chosen (or the one the dialog was opened in). */
  environmentId: string | null;
}

let memberCounter = 0;

function memberKey(): string {
  memberCounter += 1;
  return `member-${memberCounter}`;
}

export function graphLaunchMember(binding: GraphModelBinding): GraphLaunchMemberDraft {
  return { key: memberKey(), binding: structuredClone(binding) };
}

function paramControlValue(parameter: GraphParameter, value: GraphScalarValue | undefined) {
  if (parameter.type === "boolean") return value === true;
  if (value === undefined || value === null) return "";
  return String(value);
}

/** The ticket input a Kanban ticket fills: the first `ticket@1` value input. */
export function graphLaunchTicketInput(
  options: Pick<GraphLaunchOptions, "inputs">,
): GraphLaunchInputOption | null {
  return options.inputs.find((input) => input.ticket && input.launchable) ?? null;
}

/**
 * The first draft for a template: each role's default (saved, else the
 * settings'), the saved or default parameter values, the saved environment
 * kind (an existing environment only when the dialog has one) and the ticket
 * the dialog was opened with.
 */
export function initialGraphLaunchDraft(
  options: GraphLaunchOptions,
  context: { environmentId?: string | null; ticketTaskId?: string | null },
): GraphLaunchDraft {
  const roles: GraphLaunchDraft["roles"] = {};
  for (const option of options.roles) {
    const list = Array.isArray(option.default) ? option.default : [option.default];
    roles[option.role.key] = list.map(graphLaunchMember);
  }
  const params: GraphLaunchDraft["params"] = {};
  for (const parameter of options.parameters) {
    params[parameter.key] = paramControlValue(parameter, options.params[parameter.key]);
  }
  const environmentId = context.environmentId ?? null;
  let environment = options.environment.default;
  if (environment === "existing" && !environmentId) {
    environment = options.environment.create ? `new-${options.environment.create}` : "new-worktree";
  }
  // Opened from an environment with no saved choice: launch there by default.
  if (!options.saved?.environment && environmentId && !options.environment.create) {
    environment = "existing";
  }
  return {
    roles,
    params,
    inputs: {},
    ticketTaskId: context.ticketTaskId ?? null,
    environment,
    environmentId,
  };
}

/** The providers a role's picker offers: available ones only. */
export function graphLaunchAvailablePlatforms(option: GraphLaunchRoleOption): AgentPlatform[] {
  return option.providers.filter((provider) => provider.available).map((entry) => entry.platform);
}

/** The person-facing tier label of a provider for a role. */
export function graphLaunchTierLabel(provider: GraphLaunchProviderOption): string {
  switch (provider.tier) {
    case "enforced":
      return "Enforced";
    case "provider-configured":
      return "Provider-configured";
    case "advisory":
      return "Advisory";
  }
}

/**
 * Why a template in the picker cannot be launched, or null. Built-ins on
 * their own engine, untrusted project templates and templates that do not
 * compile are listed but not selectable.
 */
export function graphTemplateLaunchBlocker(summary: GraphTemplateSummary): string | null {
  if (summary.launchable) return null;
  if (summary.engine) return "Runs on its own engine; duplicate it to run a copy as a graph";
  if (summary.trust === "untrusted") return "Not trusted yet; approve it in Graphs first";
  if (summary.trust === "changed") return "Changed since it was approved; approve it again";
  if (summary.compile.errors > 0) {
    return `Does not compile (${summary.compile.errors} error${summary.compile.errors === 1 ? "" : "s"})`;
  }
  if (summary.compile.pendingAcknowledgements > 0) {
    return "Has warnings waiting for an acknowledgement in the designer";
  }
  return "Cannot be launched";
}

function parseParam(parameter: GraphParameter, raw: string | boolean | undefined) {
  if (parameter.type === "boolean") return { value: raw === true };
  const text = typeof raw === "string" ? raw : "";
  if (text.trim() === "") return { value: undefined };
  if (parameter.type === "integer" || parameter.type === "number") {
    const value = Number(text);
    return { value: Number.isNaN(value) ? text : value };
  }
  return { value: text };
}

/** A parameter's problem in the draft, or null. */
export function graphLaunchParamProblem(
  parameter: GraphParameter,
  raw: string | boolean | undefined,
): string | null {
  const { value } = parseParam(parameter, raw);
  if (value === undefined) {
    return parameter.default === undefined
      ? `${parameter.label ?? parameter.key} needs a value`
      : null;
  }
  return graphParamValueProblem(parameter, value as GraphScalarValue);
}

/**
 * Whether an input is filled from the run's environment when left empty: an
 * existing environment's commit at launch, or a new environment's once it
 * exists (the backend's provisioner stores it before the run starts).
 */
export function graphLaunchInputAutoFilled(
  input: GraphLaunchInputOption,
  _draft: Pick<GraphLaunchDraft, "environment">,
): boolean {
  return input.autoFill === "environment-head";
}

/** An input's problem in the draft, or null. */
export function graphLaunchInputProblem(
  input: GraphLaunchInputOption,
  draft: GraphLaunchDraft,
  ticketInput: string | null,
): string | null {
  const name = input.label ?? input.name;
  if (input.name === ticketInput) {
    return input.required && !draft.ticketTaskId ? `Choose a ticket for ${name}` : null;
  }
  const text = draft.inputs[input.name]?.trim() ?? "";
  if (!input.launchable) {
    return input.required ? `${name} needs a file artifact, which a launch cannot give yet` : null;
  }
  if (text === "") {
    if (graphLaunchInputAutoFilled(input, draft)) return null;
    return input.required ? `${name} needs a value` : null;
  }
  try {
    JSON.parse(text);
    return null;
  } catch {
    return `${name} must be JSON`;
  }
}

/** Every problem that keeps Launch disabled, in display order. */
export function graphLaunchProblems(
  options: GraphLaunchOptions,
  draft: GraphLaunchDraft,
): string[] {
  const problems: string[] = [];
  if (!options.launchable)
    problems.push(options.blockedReason ?? "The template cannot be launched");
  for (const option of options.roles) {
    const members = draft.roles[option.role.key] ?? [];
    const label = option.role.label ?? option.role.key;
    if (members.length === 0 || members.length > option.maxPanel) {
      problems.push(`${label} takes 1 to ${option.maxPanel} models`);
      continue;
    }
    if (option.nodes.length === 0) continue;
    const available = new Set(graphLaunchAvailablePlatforms(option));
    for (const member of members) {
      if (!available.has(member.binding.platform)) {
        problems.push(`${label}: choose a provider that meets its floor`);
        break;
      }
      const lensError = reviewLensDraftError(member.binding.lens);
      if (lensError) {
        problems.push(`${label}: ${lensError}`);
        break;
      }
    }
  }
  for (const parameter of options.parameters) {
    const problem = graphLaunchParamProblem(parameter, draft.params[parameter.key]);
    if (problem) problems.push(problem);
  }
  const ticketInput = graphLaunchTicketInput(options)?.name ?? null;
  for (const input of options.inputs) {
    const problem = graphLaunchInputProblem(input, draft, ticketInput);
    if (problem) problems.push(problem);
  }
  if (draft.environment === "existing" && !draft.environmentId) {
    problems.push("Choose the environment to run in");
  }
  return problems;
}

function cleanBinding(binding: GraphModelBinding, panel: boolean): GraphModelBinding {
  const lens = panel ? normalizeReviewLens(binding.lens as ReviewLens | undefined) : undefined;
  return {
    platform: binding.platform,
    ...(binding.model && binding.model !== "default" ? { model: binding.model } : {}),
    ...(binding.reasoningEffort && binding.reasoningEffort !== "default"
      ? { reasoningEffort: binding.reasoningEffort }
      : {}),
    ...(typeof binding.fastMode === "boolean" ? { fastMode: binding.fastMode } : {}),
    ...(lens ? { lens } : {}),
  };
}

/** The draft's role bindings as the launch sends them. */
export function graphLaunchRoleBindings(
  options: Pick<GraphLaunchOptions, "roles">,
  draft: Pick<GraphLaunchDraft, "roles">,
): NonNullable<GraphLaunchRequest["roles"]> {
  const roles: NonNullable<GraphLaunchRequest["roles"]> = {};
  for (const option of options.roles) {
    const members = (draft.roles[option.role.key] ?? []).map((member) =>
      cleanBinding(member.binding, option.panel),
    );
    if (members.length === 0) continue;
    roles[option.role.key] = option.panel ? members : members[0]!;
  }
  return roles;
}

/**
 * The request for a valid draft. Every launch saves its choices as the
 * template's defaults for the project, so the next dialog starts there.
 */
export function graphLaunchRequest(input: {
  ref: GraphTemplateRef;
  projectId: string;
  options: GraphLaunchOptions;
  draft: GraphLaunchDraft;
  requestId: string;
}): GraphLaunchRequest {
  const { options, draft } = input;
  const environment = graphLaunchEnvironmentChoice(
    draft.environment,
    draft.environmentId ?? undefined,
  );
  if (!environment) throw new Error("Choose the environment to run in");
  const params: Record<string, GraphScalarValue> = {};
  for (const parameter of options.parameters) {
    const { value } = parseParam(parameter, draft.params[parameter.key]);
    if (value !== undefined) params[parameter.key] = value as GraphScalarValue;
  }
  const ticketInput = graphLaunchTicketInput(options);
  const inputs: Record<string, unknown> = {};
  for (const option of options.inputs) {
    if (option.name === ticketInput?.name || !option.launchable) continue;
    const text = draft.inputs[option.name]?.trim() ?? "";
    if (text) inputs[option.name] = JSON.parse(text);
  }
  return {
    ref: input.ref,
    projectId: input.projectId,
    environment,
    roles: graphLaunchRoleBindings(options, draft),
    params,
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(ticketInput && draft.ticketTaskId
      ? { ticket: { taskId: draft.ticketTaskId, input: ticketInput.name } }
      : {}),
    saveDefaults: true,
    requestId: input.requestId,
  };
}

/**
 * The compile cost with the panel sizes chosen here: a replicated node bound
 * to a panel role runs one branch per member. The options carry no plan, so
 * a node counts as replicated over its role's panel when its compile
 * estimate has more than one branch.
 */
export function graphLaunchCost(
  options: Pick<GraphLaunchOptions, "cost" | "roles">,
  draft: Pick<GraphLaunchDraft, "roles">,
): { best: number; worst: number } | null {
  const cost = options.cost;
  if (!cost) return null;
  let best = 0;
  let worst = 0;
  for (const node of cost.nodes) {
    const panel = options.roles.find(
      (option) => option.panel && option.nodes.includes(node.nodeId) && node.branches.max > 1,
    );
    if (!panel) {
      best += node.agentSessions.best;
      worst += node.agentSessions.worst;
      continue;
    }
    const size = draft.roles[panel.role.key]?.length ?? 1;
    best += Math.ceil((node.agentSessions.best / Math.max(1, node.branches.min)) * size);
    worst += Math.ceil((node.agentSessions.worst / Math.max(1, node.branches.max)) * size);
  }
  return { best, worst };
}
