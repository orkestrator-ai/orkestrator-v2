import {
  GraphLaunchRequestError,
  graphLaunchParams,
  parseGraphLaunchRequest,
  parseGraphModelBinding,
  type GraphLaunchOptions,
  type GraphLaunchRequest,
} from "@orkestrator/protocol/graphs/launch";
import type {
  GraphTemplateCompileResponse,
  GraphTemplateRef,
  GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import {
  GRAPH_ACTIVATION_STATES,
  isGraphRunTerminal,
  type GraphModelBinding,
  type GraphRun,
} from "@orkestrator/protocol/graphs/run";
import { parseGraphTemplate } from "@orkestrator/protocol/graphs/template";
import type { GraphScalarValue } from "@orkestrator/protocol/graphs/template";
import { PUBLIC_API_LIMITS, type PublicErrorCode } from "@orkestrator/protocol/public-api";
import {
  parsePublicGraphTemplateRef,
  PUBLIC_GRAPH_DIAGNOSTICS_MAX,
  PUBLIC_GRAPH_VALIDATE_TEXT_MAX_BYTES,
  publicGraphTemplateRefText,
} from "@orkestrator/protocol/public-api-inputs-graph";
import type {
  PublicGraphBindingSummary,
  PublicGraphLaunchView,
  PublicGraphRunSummary,
  PublicGraphTemplateDetail,
  PublicGraphTemplateSummary,
  PublicGraphValidation,
} from "@orkestrator/protocol/public-api-resources";
import { conciseError } from "../commands-error-text.js";
import { GraphLaunchError, type GraphRunLaunchService } from "../graph-run-launch.js";
import { GraphRunServiceError, type GraphRunService } from "../graph-run-service.js";
import { GraphTemplateError } from "../graph-template-errors.js";
import type { GraphTemplateService } from "../graph-template-service.js";
import { paginate, requireEnvironment, requireProject } from "./actions-discovery.js";
import { requireTicket } from "./actions-tickets.js";
import { PublicActionError } from "./errors.js";
import {
  GRAPH_LAUNCH_SAVED_STAGE,
  graphPublicLaunchRequestId,
  graphRunActionResult,
} from "./graph-recovery.js";
import {
  invalid,
  oneOf,
  onlyActionKeys,
  optionalInteger,
  optionalString,
  requiredId,
} from "./input.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Graphs as public actions (`graph.*`, item 214), for the CLI and Control
 * MCP: list, show and validate saved templates, launch one, and read or
 * cancel a run. There is deliberately no authoring action (D6).
 *
 * `graph.launch` goes through the one launch service every surface uses
 * (`GraphRunLaunchService`, `requestedBy: "cli"`). Before admission it reads
 * the template's launch options, so a template that cannot launch, an
 * unknown role or input, a provider below a step's floor and a parameter
 * outside its declaration are refused without leaving an operation record.
 * The launch's idempotency key is derived from the public request key, so
 * restart recovery finds the run it created and never launches twice.
 *
 * Receipts and summaries carry IDs, states and counts only: never input
 * values, ticket text, prompts or a lens's text (its size instead).
 */

const MAX_ERROR_CHARS = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireTemplates(context: PublicActionContext): GraphTemplateService {
  const service = context.command.graphTemplates;
  if (!service) {
    throw new PublicActionError("capability-unavailable", "Graph templates are unavailable");
  }
  return service;
}

function requireLaunches(context: PublicActionContext): GraphRunLaunchService {
  const service = context.command.graphLaunches;
  if (!service) {
    throw new PublicActionError("capability-unavailable", "Graph launches are unavailable");
  }
  return service;
}

function requireRuns(context: PublicActionContext): GraphRunService {
  const service = context.command.graphRuns;
  if (!service) throw new PublicActionError("capability-unavailable", "Graph runs are unavailable");
  return service;
}

/**
 * The public code for a refused launch or template read. The launch code is
 * kept in `details.reason`, so a client can tell an untrusted template from a
 * missed enforcement floor without parsing text.
 */
const LAUNCH_ERROR_CODES: Record<string, PublicErrorCode> = {
  "invalid-request": "invalid-input",
  "not-found": "not-found",
  untrusted: "conflict",
  "engine-template": "unsupported",
  "not-launchable": "not-ready",
  "invalid-binding": "invalid-input",
  "invalid-launch": "invalid-input",
  conflict: "conflict",
  disabled: "capability-unavailable",
  // Template-library codes (graph.show, graph.validate).
  "invalid-template": "invalid-input",
  "digest-mismatch": "conflict",
  "revision-conflict": "revision-conflict",
  limit: "conflict",
  "invalid-ceiling": "invalid-input",
};

export function publicGraphError(error: unknown): PublicActionError | null {
  if (error instanceof PublicActionError) return error;
  if (error instanceof GraphLaunchRequestError) return invalid(error.message);
  if (error instanceof GraphLaunchError || error instanceof GraphTemplateError) {
    return new PublicActionError(
      LAUNCH_ERROR_CODES[error.code] ?? "operation-failed",
      error.message.slice(0, MAX_ERROR_CHARS),
      { details: { reason: error.code } },
    );
  }
  if (error instanceof GraphRunServiceError) {
    const code: PublicErrorCode =
      error.code === "not-found"
        ? "not-found"
        : error.code === "invalid-state"
          ? "conflict"
          : error.code === "disabled"
            ? "capability-unavailable"
            : "invalid-input";
    return new PublicActionError(code, error.message.slice(0, MAX_ERROR_CHARS), {
      details: { reason: error.code },
    });
  }
  return null;
}

async function graphCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw publicGraphError(error) ?? error;
  }
}

function templateRef(input: Record<string, unknown>, projectId?: string): GraphTemplateRef {
  const ref = parsePublicGraphTemplateRef(input.template, projectId);
  if ("error" in ref) throw invalid(ref.error);
  return ref;
}

// ------------------------------------------------------------ summaries

export function publicGraphTemplateSummary(
  summary: GraphTemplateSummary,
): PublicGraphTemplateSummary {
  return {
    template: publicGraphTemplateRefText(summary.ref),
    scope: summary.scope,
    id: summary.id,
    name: summary.name,
    revision: summary.revision,
    digest: summary.digest,
    trust: summary.trust,
    launchable: summary.launchable,
    engine: summary.engine ?? null,
    errors: summary.compile.errors,
    warnings: summary.compile.warnings,
    pendingAcknowledgements: summary.compile.pendingAcknowledgements,
    agentSessions: summary.compile.cost ? { ...summary.compile.cost.agentSessions } : null,
  };
}

function bindingSummary(binding: GraphModelBinding): PublicGraphBindingSummary {
  return {
    agent: binding.platform,
    model: binding.model ?? null,
    reasoningEffort: binding.reasoningEffort ?? null,
    fastMode: binding.fastMode ?? null,
    lens: binding.lens
      ? {
          labelBytes: Buffer.byteLength(binding.lens.label),
          instructionBytes: Buffer.byteLength(binding.lens.instruction),
        }
      : null,
  };
}

function launchView(options: GraphLaunchOptions): PublicGraphLaunchView {
  return {
    launchable: options.launchable,
    blockedReason: options.blockedReason ?? null,
    roles: options.roles.map((role) => ({
      key: role.role.key,
      panel: role.panel,
      maxPanel: role.maxPanel,
      floor: role.floor ?? null,
      providers: role.providers.map((provider) => ({
        agent: provider.platform,
        tier: provider.tier,
        available: provider.available,
        unavailableReason: provider.unavailableReason ?? null,
      })),
      default: (Array.isArray(role.default) ? role.default : [role.default]).map(bindingSummary),
    })),
    params: { ...options.params },
    environment: {
      default: options.environment.default,
      create: options.environment.create ?? null,
    },
  };
}

/** Live (not superseded) activations by state. */
function nodeCounts(run: GraphRun): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const state of GRAPH_ACTIVATION_STATES) {
    if (state === "superseded") continue;
    const count = run.activations.filter((activation) => activation.state === state).length;
    if (count > 0) counts[state] = count;
  }
  return counts;
}

export function publicGraphRunSummary(run: GraphRun): PublicGraphRunSummary {
  return {
    id: run.id,
    projectId: run.projectId,
    environmentId: run.environmentId ?? null,
    template: {
      id: run.plan.template.id,
      revision: run.plan.template.revision,
      name: run.plan.template.name,
      scope: run.template.scope ?? null,
    },
    status: run.status,
    mock: run.mock,
    requestedBy: run.launch?.requestedBy ?? null,
    ticketId: run.launch?.ticket?.taskId ?? null,
    activations: nodeCounts(run),
    usage: { agentSessions: run.usage.agentSessions, tokens: run.usage.tokens },
    error: run.error ? run.error.slice(0, MAX_ERROR_CHARS) : null,
    errorCause: run.errorCause ?? null,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    updatedAt: run.updatedAt,
    revision: run.revision,
  };
}

function validation(
  template: string | null,
  response: GraphTemplateCompileResponse,
): PublicGraphValidation {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const diagnostic of response.diagnostics) {
    if (diagnostic.severity === "error") errors += 1;
    else if (diagnostic.severity === "warning") warnings += 1;
    else infos += 1;
  }
  const shown = response.diagnostics.slice(0, PUBLIC_GRAPH_DIAGNOSTICS_MAX);
  return {
    template,
    ok: response.ok,
    launchable: response.launchable,
    blockedBy: response.blockedBy ?? null,
    errors,
    warnings,
    infos,
    pendingAcknowledgements: response.pendingAcknowledgements.length,
    diagnostics: shown.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message.slice(0, MAX_ERROR_CHARS),
      nodeId: diagnostic.nodeId ?? null,
      path: diagnostic.path ?? null,
    })),
    omittedDiagnostics: response.omittedDiagnostics + (response.diagnostics.length - shown.length),
    planDigest: response.planDigest,
    cost: response.cost
      ? {
          agentSessions: { ...response.cost.agentSessions },
          activations: { ...response.cost.activations },
          peakParallelism: response.cost.peakParallelism,
        }
      : null,
  };
}

// ------------------------------------------------------------ reads

const graphList: ReadActionHandler<{ projectId?: string; limit?: number; cursor?: string }> = {
  kind: "read",
  action: "graph.list",
  parse(input) {
    onlyActionKeys(input, "graph.list");
    return {
      ...(input.projectId !== undefined ? { projectId: requiredId(input, "projectId") } : {}),
      limit: optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.pageMaxItems),
      cursor: optionalString(input, "cursor", 512),
    };
  },
  async run(input, context) {
    if (input.projectId) await requireProject(context, input.projectId);
    const listed = await graphCall(() =>
      requireTemplates(context).list(input.projectId ? { projectId: input.projectId } : {}),
    );
    // Paged by reference: a built-in and a user template may share an id.
    const items = listed.templates.map((summary) => ({
      id: publicGraphTemplateRefText(summary.ref),
      summary: publicGraphTemplateSummary(summary),
    }));
    const page = paginate(items, input);
    return { result: { ...page, items: page.items.map((item) => item.summary) } };
  },
};

const graphShow: ReadActionHandler<{
  ref: GraphTemplateRef;
  projectId?: string;
  environmentId?: string;
}> = {
  kind: "read",
  action: "graph.show",
  parse(input) {
    onlyActionKeys(input, "graph.show");
    const projectId = input.projectId !== undefined ? requiredId(input, "projectId") : undefined;
    const environmentId =
      input.environmentId !== undefined ? requiredId(input, "environmentId") : undefined;
    if (environmentId && !projectId) throw invalid("environmentId requires projectId");
    return {
      ref: templateRef(input, projectId),
      ...(projectId ? { projectId } : {}),
      ...(environmentId ? { environmentId } : {}),
    };
  },
  async run(input, context) {
    if (input.projectId) await requireProject(context, input.projectId);
    const detail = await graphCall(() =>
      requireTemplates(context).get(
        input.ref,
        input.projectId ? { projectId: input.projectId } : {},
      ),
    );
    let launch: PublicGraphLaunchView | null = null;
    if (input.projectId) {
      try {
        launch = launchView(
          await requireLaunches(context).options({
            ref: input.ref,
            projectId: input.projectId,
            ...(input.environmentId ? { environmentId: input.environmentId } : {}),
          }),
        );
      } catch (error) {
        // An untrusted or engine template still shows; it says why it cannot launch.
        if (!(error instanceof GraphLaunchError) || error.code === "not-found") {
          throw publicGraphError(error) ?? error;
        }
        launch = {
          launchable: false,
          blockedReason: error.message.slice(0, MAX_ERROR_CHARS),
          roles: [],
          params: {},
          environment: { default: "new-worktree", create: null },
        };
      }
    }
    const template = detail.template;
    const result: PublicGraphTemplateDetail = {
      ...publicGraphTemplateSummary(detail.summary),
      description: template.description ?? null,
      roles: template.roles.map((role) => ({
        key: role.key,
        label: role.label ?? null,
        multiplicity: role.multiplicity,
        maxPanel: role.maxPanel ?? null,
        defaultsFrom: [...(role.defaultsFrom ?? [])],
      })),
      parameters: template.parameters.map((parameter) => ({
        key: parameter.key,
        type: parameter.type,
        label: parameter.label ?? null,
        default: parameter.default ?? null,
        min: "min" in parameter ? (parameter.min ?? null) : null,
        max: "max" in parameter ? (parameter.max ?? null) : null,
        options: parameter.type === "enum" ? [...parameter.options] : null,
      })),
      inputs: template.inputs.map((entry) => ({
        name: entry.name,
        type: entry.type,
        required: entry.required !== false,
        ticket: entry.type === "ticket@1",
      })),
      steps: template.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label ?? null,
        role: node.kind === "agent" ? node.role : null,
      })),
      workspace: {
        kind: template.workspace.kind,
        create:
          template.workspace.kind === "environment"
            ? (template.workspace.create?.kind ?? null)
            : null,
      },
      launch,
    };
    return { result };
  },
};

const graphValidate: ReadActionHandler<{
  ref?: GraphTemplateRef;
  text?: string;
  projectId?: string;
}> = {
  kind: "read",
  action: "graph.validate",
  parse(input) {
    onlyActionKeys(input, "graph.validate");
    const projectId = input.projectId !== undefined ? requiredId(input, "projectId") : undefined;
    if ((input.template === undefined) === (input.text === undefined)) {
      throw invalid("Give exactly one of template and text");
    }
    if (input.text !== undefined) {
      if (typeof input.text !== "string" || input.text.trim().length === 0) {
        throw invalid("text must be a template's JSON");
      }
      if (Buffer.byteLength(input.text) > PUBLIC_GRAPH_VALIDATE_TEXT_MAX_BYTES) {
        throw new PublicActionError(
          "input-too-large",
          `text must be at most ${PUBLIC_GRAPH_VALIDATE_TEXT_MAX_BYTES} bytes`,
        );
      }
      return { text: input.text, ...(projectId ? { projectId } : {}) };
    }
    return { ref: templateRef(input, projectId), ...(projectId ? { projectId } : {}) };
  },
  async run(input, context) {
    if (input.projectId) await requireProject(context, input.projectId);
    const service = requireTemplates(context);
    const options = input.projectId ? { projectId: input.projectId } : {};
    if (input.text !== undefined) {
      // Compiled, never saved. A document the guard refuses (bad JSON,
      // duplicate keys, schema) reports its field errors as diagnostics.
      const parsed = parseGraphTemplate(input.text);
      if (!parsed.ok) {
        const diagnostics = parsed.errors.slice(0, PUBLIC_GRAPH_DIAGNOSTICS_MAX);
        const result: PublicGraphValidation = {
          template: null,
          ok: false,
          launchable: false,
          blockedBy: null,
          errors: parsed.errors.length + parsed.omittedErrors,
          warnings: 0,
          infos: 0,
          pendingAcknowledgements: 0,
          diagnostics: diagnostics.map((error) => ({
            code: `template-${error.code}`,
            severity: "error",
            message: error.message.slice(0, MAX_ERROR_CHARS),
            nodeId: null,
            path: error.path,
          })),
          omittedDiagnostics: parsed.omittedErrors + (parsed.errors.length - diagnostics.length),
          planDigest: null,
          cost: null,
        };
        return { result };
      }
      const compiled = await graphCall(() => service.compile({ template: parsed.value }, options));
      return { result: validation(null, compiled) };
    }
    const ref = input.ref!;
    const compiled = await graphCall(() => service.compile({ ref }, options));
    return { result: validation(publicGraphTemplateRefText(ref), compiled) };
  },
};

const graphStatus: ReadActionHandler<{ runId: string }> = {
  kind: "read",
  action: "graph.status",
  parse(input) {
    onlyActionKeys(input, "graph.status");
    return { runId: requiredId(input, "runId") };
  },
  async run(input, context) {
    return { result: publicGraphRunSummary(await requireRun(context, input.runId)) };
  },
};

async function requireRun(context: PublicActionContext, runId: string): Promise<GraphRun> {
  const run = await requireRuns(context).get(runId);
  if (!run) throw new PublicActionError("not-found", `Graph run not found: ${runId}`);
  return run;
}

// ------------------------------------------------------------ launch

export interface GraphLaunchInput {
  projectId: string;
  template: string;
  ref: GraphTemplateRef;
  environmentId?: string;
  newEnvironment?: "worktree" | "container";
  /** Role key → its models, as given (a list per role). */
  roles?: Record<string, GraphModelBinding[]>;
  params?: Record<string, GraphScalarValue>;
  inputs?: Record<string, unknown>;
  ticketId?: string;
  ticketInput?: string;
}

/** A role's list of `{agent, …}` rows as model bindings. */
function parseRoles(value: unknown): Record<string, GraphModelBinding[]> {
  if (!isObject(value)) throw invalid("roles must be an object of role key → models");
  const roles: Record<string, GraphModelBinding[]> = {};
  for (const [key, rows] of Object.entries(value)) {
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 32) {
      throw invalid(`roles.${key.slice(0, 64)} must list 1 to 32 models`);
    }
    roles[key] = rows.map((row, index) => {
      const path = `roles.${key.slice(0, 64)}[${index}]`;
      if (!isObject(row)) throw invalid(`${path} must be an object with an agent`);
      const { agent, ...rest } = row;
      try {
        return parseGraphModelBinding({ platform: agent, ...rest }, path);
      } catch (error) {
        throw invalid((error as Error).message.replace(`${path}.platform`, `${path}.agent`));
      }
    });
  }
  return roles;
}

/** The launch request, shape-checked by the protocol's own parser. */
function launchRequest(
  input: GraphLaunchInput,
  roles: GraphLaunchRequest["roles"] | undefined,
): GraphLaunchRequest {
  try {
    return parseGraphLaunchRequest({
      ref: input.ref,
      projectId: input.projectId,
      environment: input.environmentId
        ? { kind: "existing", environmentId: input.environmentId }
        : { kind: "new", create: input.newEnvironment },
      ...(roles ? { roles } : {}),
      ...(input.params ? { params: input.params } : {}),
      ...(input.inputs ? { inputs: input.inputs } : {}),
      ...(input.ticketId
        ? {
            ticket: {
              taskId: input.ticketId,
              ...(input.ticketInput ? { input: input.ticketInput } : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof GraphLaunchRequestError) throw invalid(error.message);
    throw error;
  }
}

export function parseGraphLaunch(input: Record<string, unknown>): GraphLaunchInput {
  onlyActionKeys(input, "graph.launch");
  const projectId = requiredId(input, "projectId");
  const template = optionalString(input, "template", 400);
  if (!template) throw invalid("template is required");
  const ref = templateRef(input, projectId);
  const environmentId =
    input.environmentId !== undefined ? requiredId(input, "environmentId") : undefined;
  const newEnvironment = oneOf(input, "newEnvironment", ["worktree", "container"] as const);
  if ((environmentId ? 1 : 0) + (newEnvironment ? 1 : 0) !== 1) {
    throw invalid("Give exactly one of environmentId and newEnvironment");
  }
  const parsed: GraphLaunchInput = {
    projectId,
    template,
    ref,
    ...(environmentId ? { environmentId } : {}),
    ...(newEnvironment ? { newEnvironment } : {}),
    ...(input.roles !== undefined ? { roles: parseRoles(input.roles) } : {}),
    ...(input.params !== undefined
      ? { params: input.params as Record<string, GraphScalarValue> }
      : {}),
    ...(input.inputs !== undefined ? { inputs: input.inputs as Record<string, unknown> } : {}),
    ...(input.ticketId !== undefined ? { ticketId: requiredId(input, "ticketId") } : {}),
    ...(input.ticketInput !== undefined
      ? { ticketInput: optionalString(input, "ticketInput", 64)! }
      : {}),
  };
  if (parsed.ticketInput && !parsed.ticketId) throw invalid("ticketInput requires ticketId");
  // Bounds and shapes (params scalars, input bytes, lens sizes) are the protocol's.
  launchRequest(parsed, parsed.roles);
  return parsed;
}

/**
 * The launch's roles in the plan's shape (one binding or a panel list), each
 * provider checked against what the role may run on here. Refused before
 * admission, as are unknown roles, inputs and parameter values.
 */
function checkedLaunch(input: GraphLaunchInput, options: GraphLaunchOptions): GraphLaunchRequest {
  if (!options.launchable) {
    throw new PublicActionError(
      "not-ready",
      (options.blockedReason ?? "The template cannot be launched").slice(0, MAX_ERROR_CHARS),
      { details: { reason: "not-launchable" } },
    );
  }
  const declared = new Map(options.roles.map((role) => [role.role.key, role]));
  let roles: GraphLaunchRequest["roles"] | undefined;
  if (input.roles) {
    roles = {};
    for (const [key, rows] of Object.entries(input.roles)) {
      const role = declared.get(key);
      if (!role) {
        throw new PublicActionError("invalid-input", `The template has no role ${key}`, {
          details: { reason: "invalid-binding" },
        });
      }
      if (rows.length > role.maxPanel) {
        throw new PublicActionError(
          "invalid-input",
          role.panel
            ? `The panel ${key} takes 1 to ${role.maxPanel} models`
            : `The role ${key} takes exactly one model`,
          { details: { reason: "invalid-binding" } },
        );
      }
      for (const row of rows) {
        const provider = role.providers.find((entry) => entry.platform === row.platform);
        if (role.nodes.length > 0 && (!provider || !provider.available)) {
          throw new PublicActionError(
            "invalid-input",
            `${row.platform} cannot run role ${key}: ${provider?.unavailableReason ?? "not enabled"}`.slice(
              0,
              MAX_ERROR_CHARS,
            ),
            { details: { reason: "invalid-binding" } },
          );
        }
      }
      roles[key] = role.panel ? rows : rows[0]!;
    }
  }
  const params = graphLaunchParams(options.parameters, input.params ?? {}, options.params);
  if (params.issues.length > 0) {
    throw new PublicActionError("invalid-input", params.issues.slice(0, 3).join("; "), {
      details: { reason: "invalid-launch" },
    });
  }
  const names = new Map(options.inputs.map((entry) => [entry.name, entry]));
  for (const name of Object.keys(input.inputs ?? {})) {
    const entry = names.get(name);
    if (!entry || !entry.launchable) {
      throw new PublicActionError(
        "invalid-input",
        entry
          ? `The run input ${name} needs a reference artifact`
          : `The template has no run input ${name}`,
        { details: { reason: "invalid-launch" } },
      );
    }
  }
  return launchRequest(input, roles);
}

/** The launch's canonical intent: the validated input (the template as written, not its parsed ref). */
export function graphLaunchIntent(value: GraphLaunchInput): Omit<GraphLaunchInput, "ref"> {
  const { ref: _ref, ...intent } = value;
  return intent;
}

const graphLaunch: MutationActionHandler<GraphLaunchInput> = {
  kind: "mutation",
  action: "graph.launch",
  parse(input) {
    const value = parseGraphLaunch(input);
    return { value, scope: `project:${value.projectId}`, intent: graphLaunchIntent(value) };
  },
  async prepare(input, context) {
    const launches = requireLaunches(context);
    await requireProject(context, input.projectId);
    if (input.environmentId) {
      const environment = await requireEnvironment(context, input.environmentId);
      if (environment.projectId !== input.projectId) {
        throw invalid("The environment belongs to another project");
      }
    }
    if (input.ticketId) await requireTicket(context, input.projectId, input.ticketId);
    const options = await graphCall(() =>
      launches.options({
        ref: input.ref,
        projectId: input.projectId,
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        ...(input.newEnvironment ? { create: input.newEnvironment } : {}),
      }),
    );
    const request = checkedLaunch(input, options);
    return {
      resources: {
        projectId: input.projectId,
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      },
      async execute(operation) {
        try {
          const launched = await launches.launch(
            { ...request, requestId: graphPublicLaunchRequestId(operation.current().requestKey) },
            { requestedBy: "cli" },
          );
          const run = await context.command.storage.graphRuns.getGraphRun(launched.runId);
          return {
            state: "succeeded",
            stage: GRAPH_LAUNCH_SAVED_STAGE,
            result: run
              ? graphRunActionResult(run)
              : {
                  runId: launched.runId,
                  projectId: launched.projectId,
                  environmentId: launched.environmentId ?? null,
                  status: launched.status,
                  template: launched.template,
                },
            resources: {
              projectId: launched.projectId,
              ...(launched.environmentId ? { environmentId: launched.environmentId } : {}),
            },
          };
        } catch (error) {
          const mapped = publicGraphError(error);
          return {
            state: "failed",
            error: {
              code: mapped?.code ?? "operation-failed",
              message: (mapped?.message ?? conciseError(error)).slice(0, MAX_ERROR_CHARS),
            },
          };
        }
      },
    };
  },
};

const graphCancel: MutationActionHandler<{ runId: string }> = {
  kind: "mutation",
  action: "graph.cancel",
  parse(input) {
    onlyActionKeys(input, "graph.cancel");
    const runId = requiredId(input, "runId");
    return { value: { runId }, scope: `graph-run:${runId}`, intent: { runId } };
  },
  async prepare(input, context) {
    const runs = requireRuns(context);
    const run = await requireRun(context, input.runId);
    if (isGraphRunTerminal(run.status)) {
      throw new PublicActionError(
        "conflict",
        `The graph run already ended (${run.status}); nothing was cancelled`,
        { details: { status: run.status } },
      );
    }
    return {
      resources: {
        projectId: run.projectId,
        ...(run.environmentId ? { environmentId: run.environmentId } : {}),
      },
      async execute() {
        try {
          return {
            state: "succeeded",
            result: graphRunActionResult(await runs.cancel(input.runId)),
          };
        } catch (error) {
          const mapped = publicGraphError(error);
          return {
            state: "failed",
            error: {
              code: mapped?.code ?? "operation-failed",
              message: (mapped?.message ?? conciseError(error)).slice(0, MAX_ERROR_CHARS),
            },
          };
        }
      },
    };
  },
};

export const GRAPH_HANDLERS: PublicActionHandler[] = [
  graphList,
  graphShow,
  graphValidate,
  graphLaunch,
  graphStatus,
  graphCancel,
];
