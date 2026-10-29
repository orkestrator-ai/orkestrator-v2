/**
 * Graph launches (item 214, plan P2.14, D6, D7, D17; report §7.6): the one
 * path from a saved template to a run. The launch dialog, the designer's
 * Run, the CLI's `graph.launch` action, the coordinator's `launch_graph` tool
 * and scheduled jobs all call {@link GraphRunLaunchService.launch}, so every
 * entry point launches the same run.
 *
 * A launch:
 *
 * 1. resolves the stored template and compiles it for launch
 *    (`GraphTemplateService.compileForLaunch`): untrusted project templates,
 *    engine templates and drafts are refused, and capability profiles narrow
 *    the **real** launch environment's policy (an existing environment's own
 *    policy, or the policy a new worktree or restricted container gets) under
 *    the project's ceiling;
 * 2. binds every role: the request's bindings, else the defaults saved for
 *    this template in the project, else the settings defaults (item 108's
 *    reading of `defaultsFrom`); panels take lists of 1..`maxPanel` models;
 * 3. checks each binding: an enabled provider that meets the floor of every
 *    node bound to its role (`graphBindingFloorProblems`, item 209) and can
 *    return the role's typed results;
 * 4. resolves parameters and inputs (a Kanban ticket becomes the `ticket@1`
 *    input through `graphTicketFromTaskSnapshot`);
 * 5. creates the run (`GraphRunService.create`) on an existing environment,
 *    or without one so the provisioner creates it (D7), and links the ticket
 *    to the run's environment (now, or when the provisioner creates it).
 *
 * `requestId` makes a launch idempotent: the run id is derived from it, so a
 * repeat returns the run it created.
 *
 * Runs that end before they have an environment (failed provisioning) are
 * not removed by environment deletion. {@link GraphRunLaunchService.sweep}
 * keeps at most 20 per project and none that ended more than 7 days ago; it
 * runs at startup and after every launch.
 *
 * Logs carry ids, codes and counts only.
 */
import { createHash } from "node:crypto";
import {
  AGENT_PLATFORMS,
  isAgentPlatform,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  resolveActionDefaults,
  resolveDefaultAgent,
  resolveMultiReviewSettings,
  type AgentSettingsTiers,
} from "@orkestrator/protocol/agent-settings";
import type { TaskSnapshot } from "@orkestrator/protocol/build-pipeline";
import { graphBindingFloorProblems } from "@orkestrator/protocol/graphs/agent-enforcement";
import type { AgentEnforcementHost } from "@orkestrator/protocol/graphs/capability-profiles";
import type { CompiledGraphPlan, GraphPlanAgentNode } from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_LAUNCH_BOUNDS,
  GraphLaunchRequestError,
  graphLaunchEnvironmentKey,
  graphLaunchParams,
  graphRoleDefaultBindings,
  graphTicketInputName,
  type GraphLaunchDefaults,
  type GraphLaunchErrorCode,
  type GraphLaunchInputOption,
  type GraphLaunchOptions,
  type GraphLaunchOrigin,
  type GraphLaunchProviderOption,
  type GraphLaunchRequest,
  type GraphLaunchResult,
  type GraphLaunchRoleOption,
} from "@orkestrator/protocol/graphs/launch";
import {
  graphTemplateRefKey,
  type GraphTemplateCompileResponse,
  type GraphTemplateRef,
} from "@orkestrator/protocol/graphs/library";
import {
  isGraphRunTerminal,
  type GraphModelBinding,
  type GraphRun,
  type GraphRunBindings,
} from "@orkestrator/protocol/graphs/run";
import type { GraphRole } from "@orkestrator/protocol/graphs/template";
import { GraphTypeLibrary, graphTicketFromTaskSnapshot } from "@orkestrator/protocol/graphs/types";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  normalizeTicketContent,
  TICKET_SECTION_LIMITS,
} from "@orkestrator/protocol/ticket-sections";
import { GraphRunServiceError, type GraphRunService } from "./graph-run-service.js";
import { GraphTemplateError } from "./graph-template-errors.js";
import type { GraphTemplateService } from "./graph-template-service.js";
import type { AppConfig, Environment, Project } from "./models.js";
import { resolveEnvironmentExecutionPolicy } from "./native-agent-execution-policy.js";
import type { KanbanTask } from "./storage-shared-core.js";
import type { GraphRunsStorage } from "./storage-graph-runs.js";
import type { GraphTemplatesStorage } from "./storage-graph-templates.js";

/** A refused launch; `code` is the same on every surface. Messages carry no content. */
export class GraphLaunchError extends Error {
  constructor(
    readonly code: GraphLaunchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GraphLaunchError";
  }
}

export interface GraphRunLaunchStorage {
  getProject(projectId: string): Promise<Project | null>;
  getEnvironment(environmentId: string): Promise<Environment | null>;
  loadConfig(): Promise<AppConfig>;
  kanban: { getKanbanTask(taskId: string): Promise<KanbanTask | null> };
  graphTemplates: Pick<GraphTemplatesStorage, "getGraphLaunchDefaults" | "saveGraphLaunchDefaults">;
  graphRuns: Pick<
    GraphRunsStorage,
    "getGraphRun" | "listAllGraphRuns" | "deleteEnvironmentlessGraphRun"
  >;
}

export interface GraphRunLaunchDependencies {
  storage: GraphRunLaunchStorage;
  templates: Pick<GraphTemplateService, "compileForLaunch">;
  runs: Pick<GraphRunService, "create" | "get">;
  /** The settings tiers a launch inherits (environment → repository → app). */
  settingsTiers(projectId: string, environment: Environment | null): Promise<AgentSettingsTiers>;
  /** Whether a provider can return typed results (result tools or structured output). */
  structuredResults?(platform: AgentPlatform): boolean;
  /**
   * The environment's current branch and HEAD commit, for a `workspace@1`
   * run input the launch leaves empty. Absent: such inputs must be given.
   */
  workspaceHead?(environment: Environment): Promise<{ branch: string; headRef: string }>;
  /** Links a ticket to an environment (`update_kanban_task`). */
  linkTicket(taskId: string, environmentId: string): Promise<void>;
  /** The host the launch compile judged providers on, for re-checking floors. */
  host?: () => AgentEnforcementHost;
  clock?: () => Date;
}

const MAX_OPTION_ERRORS = 20;

function invalid(message: string): never {
  throw new GraphLaunchError("invalid-request", message);
}

/** Maps the services' own refusals onto launch codes. */
function launchErrorOf(error: unknown): unknown {
  if (error instanceof GraphLaunchError) return error;
  if (error instanceof GraphLaunchRequestError) {
    return new GraphLaunchError("invalid-request", error.message);
  }
  if (error instanceof GraphTemplateError) {
    const code: GraphLaunchErrorCode =
      error.code === "untrusted" || error.code === "engine-template" || error.code === "not-found"
        ? error.code
        : error.code === "invalid-template"
          ? "not-launchable"
          : "invalid-request";
    return new GraphLaunchError(code, error.message);
  }
  if (error instanceof GraphRunServiceError) {
    const code: GraphLaunchErrorCode =
      error.code === "disabled"
        ? "disabled"
        : error.code === "invalid-launch"
          ? "invalid-launch"
          : error.code === "not-found"
            ? "not-found"
            : "invalid-request";
    return new GraphLaunchError(code, error.message);
  }
  return error;
}

/** A run id derived from an idempotency key, so a repeat finds the run it created. */
export function graphLaunchRunId(projectId: string, requestId: string): string {
  return `launch-${createHash("sha256").update(`${projectId}\n${requestId}`).digest("hex").slice(0, 40)}`;
}

function runScope(ref: GraphTemplateRef): "built-in" | "user" | "project" {
  return ref.scope === "builtin" ? "built-in" : ref.scope;
}

function agentNodes(plan: CompiledGraphPlan): GraphPlanAgentNode[] {
  return plan.nodes.filter((node): node is GraphPlanAgentNode => node.kind === "agent");
}

/** The role's nodes return typed results (anything but `workspace@1`). */
function needsResults(nodes: readonly GraphPlanAgentNode[]): boolean {
  return nodes.some((node) => node.outputs.some((port) => !port.type.startsWith("workspace@")));
}

function maxPanelOf(role: GraphRole): number {
  return Math.max(1, Math.min(role.maxPanel ?? 32, 32));
}

function bindingList(binding: GraphModelBinding | GraphModelBinding[]): GraphModelBinding[] {
  return Array.isArray(binding) ? binding : [binding];
}

export class GraphRunLaunchService {
  private readonly clock: () => Date;
  private sweeping: Promise<number> | null = null;

  constructor(private readonly deps: GraphRunLaunchDependencies) {
    this.clock = deps.clock ?? (() => new Date());
  }

  // ------------------------------------------------------------ options

  /**
   * What the launch dialog shows for a template in a project: the roles with
   * every enabled provider's tier and availability, parameters, inputs, the
   * environment choice and the defaults to start from. `environmentId` names
   * the environment the dialog would launch on; without it the template is
   * compiled as for a new environment of its default kind.
   */
  async options(input: {
    ref: GraphTemplateRef;
    projectId: string;
    environmentId?: string;
    create?: "worktree" | "container";
  }): Promise<GraphLaunchOptions> {
    try {
      await this.requireProject(input.projectId);
      const environment = input.environmentId
        ? await this.requireEnvironment(input.environmentId, input.projectId)
        : null;
      const templateKey = graphTemplateRefKey(input.ref);
      const saved = this.deps.storage.graphTemplates.getGraphLaunchDefaults(
        input.projectId,
        templateKey,
      );
      const compiled = await this.deps.templates.compileForLaunch(
        input.ref,
        input.projectId,
        await this.launchPolicy(environment, input.create ?? null),
      );
      if (!compiled.summary) throw new GraphLaunchError("not-found", "The template was not found");
      const plan = compiled.plan;
      const enabled = await this.enabledProviders();
      const defaults = plan
        ? await this.defaultRoles(plan, input.projectId, environment, enabled, saved)
        : {};
      const roles = plan ? this.roleOptions(plan, compiled, defaults) : [];
      const params = plan ? graphLaunchParams(plan.parameters, {}, saved?.params).params : {};
      const create =
        plan?.workspace.kind === "environment" ? plan.workspace.create?.kind : undefined;
      const fallbackEnvironment: GraphLaunchOptions["environment"]["default"] = create
        ? `new-${create}`
        : environment
          ? "existing"
          : "new-worktree";
      return {
        summary: compiled.summary,
        launchable: compiled.launchable && !!plan,
        ...(this.blockedReason(compiled) ? { blockedReason: this.blockedReason(compiled)! } : {}),
        errors: compiled.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .slice(0, MAX_OPTION_ERRORS),
        roles,
        parameters: plan ? structuredClone(plan.parameters) : [],
        params,
        inputs: plan ? this.inputOptions(plan) : [],
        environment: {
          workspace: plan?.workspace.kind ?? "environment",
          ...(create ? { create } : {}),
          default: saved?.environment ?? fallbackEnvironment,
        },
        cost: compiled.cost,
        saved,
      };
    } catch (error) {
      throw launchErrorOf(error);
    }
  }

  private blockedReason(compiled: GraphTemplateCompileResponse): string | undefined {
    if (compiled.launchable && compiled.plan) return undefined;
    if (compiled.blockedBy) return "The project template is not trusted at its current digest";
    if (!compiled.ok) {
      const first = compiled.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      return first
        ? `The template does not compile: ${first.message}`
        : "The template does not compile";
    }
    if (compiled.pendingAcknowledgements.length > 0) {
      return "The template has warnings waiting for an acknowledgement in the designer";
    }
    return "The template cannot be launched";
  }

  private roleOptions(
    plan: CompiledGraphPlan,
    compiled: GraphTemplateCompileResponse,
    defaults: GraphRunBindings["roles"],
  ): GraphLaunchRoleOption[] {
    const nodes = agentNodes(plan);
    return plan.roles.map((role) => {
      const bound = nodes.filter((node) => node.role === role.key);
      const choices = compiled.providerChoices?.find((entry) => entry.role === role.key);
      const results = needsResults(bound);
      const providers: GraphLaunchProviderOption[] = (choices?.choices ?? []).map((choice) => {
        const structuredResults = !results || this.structuredResults(choice.platform);
        const unavailableReason = !choice.allowed
          ? `Holds step ${choice.blockedBy?.nodeId ?? "?"} only at ${choice.blockedBy?.tier ?? choice.tier}, below its floor (${choice.blockedBy?.floor ?? choice.tier})${choice.reason ? `. ${choice.reason}` : ""}`
          : !structuredResults
            ? "Cannot return this role's typed results on this host"
            : undefined;
        return {
          ...choice,
          structuredResults,
          available: choice.allowed && structuredResults,
          ...(unavailableReason ? { unavailableReason: unavailableReason.slice(0, 600) } : {}),
        };
      });
      return {
        role: structuredClone(role),
        nodes: bound.sort((a, b) => a.order - b.order).map((node) => node.id),
        ...(choices?.floor ? { floor: choices.floor } : {}),
        panel: role.multiplicity === "panel",
        maxPanel: role.multiplicity === "panel" ? maxPanelOf(role) : 1,
        providers,
        default: structuredClone(defaults[role.key] ?? { platform: "claude" }),
      };
    });
  }

  private inputOptions(plan: CompiledGraphPlan): GraphLaunchInputOption[] {
    const library = new GraphTypeLibrary(plan.types);
    return plan.inputs.map((entry) => {
      const resolution = library.resolve(entry.type);
      const launchable =
        resolution.ok &&
        resolution.type.kind === "named" &&
        resolution.type.definition.storage === "value";
      return {
        name: entry.name,
        type: entry.type,
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        required: entry.required,
        ticket: entry.type === "ticket@1",
        launchable,
        ...(entry.type === "workspace@1" && this.deps.workspaceHead
          ? { autoFill: "environment-head" as const }
          : {}),
      };
    });
  }

  // ------------------------------------------------------------ launch

  /** Launches a run (see the module comment). Throws {@link GraphLaunchError}. */
  async launch(request: GraphLaunchRequest, origin: GraphLaunchOrigin): Promise<GraphLaunchResult> {
    try {
      const result = await this.launchOnce(request, origin);
      if (!result.repeated) void this.sweep().catch(() => undefined);
      return result;
    } catch (error) {
      throw launchErrorOf(error);
    }
  }

  private async launchOnce(
    request: GraphLaunchRequest,
    origin: GraphLaunchOrigin,
  ): Promise<GraphLaunchResult> {
    const runId = request.requestId
      ? graphLaunchRunId(request.projectId, request.requestId)
      : undefined;
    if (runId) {
      const existing = await this.deps.storage.graphRuns.getGraphRun(runId);
      if (existing) return this.repeated(existing, request);
    }
    await this.requireProject(request.projectId);
    const environment =
      request.environment.kind === "existing"
        ? await this.requireEnvironment(request.environment.environmentId, request.projectId)
        : null;
    const create = request.environment.kind === "new" ? request.environment.create : null;
    const templateKey = graphTemplateRefKey(request.ref);
    const saved = this.deps.storage.graphTemplates.getGraphLaunchDefaults(
      request.projectId,
      templateKey,
    );
    const compiled = await this.deps.templates.compileForLaunch(
      request.ref,
      request.projectId,
      await this.launchPolicy(environment, create),
    );
    const plan = compiled.plan;
    if (!compiled.summary) throw new GraphLaunchError("not-found", "The template was not found");
    if (!compiled.launchable || !plan) {
      throw new GraphLaunchError(
        "not-launchable",
        this.blockedReason(compiled) ?? "The template cannot be launched",
      );
    }
    const enabled = await this.enabledProviders();
    const defaults = await this.defaultRoles(plan, request.projectId, environment, enabled, saved);
    const roles = this.bindRoles(plan, compiled, request.roles ?? {}, defaults, enabled);
    const params = graphLaunchParams(plan.parameters, request.params ?? {}, saved?.params);
    if (params.issues.length > 0) {
      throw new GraphLaunchError("invalid-launch", params.issues.slice(0, 3).join("; "));
    }
    const inputs = { ...request.inputs };
    let ticketId: string | undefined;
    if (request.ticket) {
      const name = graphTicketInputName(plan, request.ticket.input);
      if (!name) {
        throw new GraphLaunchError(
          "invalid-launch",
          request.ticket.input
            ? `The template has no ticket input ${request.ticket.input}`
            : "The template has no single ticket input; name the input the ticket fills",
        );
      }
      if (name in inputs) {
        throw new GraphLaunchError("invalid-launch", `The run input ${name} was given twice`);
      }
      inputs[name] = await this.ticketValue(request.ticket.taskId, request.projectId);
      ticketId = request.ticket.taskId;
    }
    await this.fillWorkspaceInputs(plan, inputs, environment);
    const scope = runScope(request.ref);
    const run = await this.deps.runs.create({
      ...(runId ? { id: runId } : {}),
      projectId: request.projectId,
      ...(environment ? { environmentId: environment.id } : {}),
      template: {
        id: compiled.summary.id,
        revision: compiled.summary.revision,
        digest: compiled.summary.digest,
        scope,
      },
      plan,
      roles,
      params: params.params,
      inputs,
      launch: {
        requestedBy: origin.requestedBy,
        ...(create ? { create } : {}),
        ...(ticketId ? { ticket: { taskId: ticketId } } : {}),
        ...(origin.scheduleId ? { scheduleId: origin.scheduleId } : {}),
      },
    });
    if (ticketId && environment) {
      try {
        await this.deps.linkTicket(ticketId, environment.id);
      } catch (error) {
        console.warn(
          "[graphs] Could not link the launched run's ticket:",
          run.id,
          error instanceof Error ? error.name : "error",
        );
      }
    }
    if (request.saveDefaults) {
      this.deps.storage.graphTemplates.saveGraphLaunchDefaults(request.projectId, templateKey, {
        roles: structuredClone(roles),
        params: { ...params.params },
        environment: graphLaunchEnvironmentKey(request.environment),
        updatedAt: this.clock().toISOString(),
      });
    }
    console.info(
      `[graphs] Launched run ${run.id} (${origin.requestedBy}, ${plan.nodes.length} nodes, ${environment ? "existing" : "new"} environment)`,
    );
    return {
      runId: run.id,
      projectId: run.projectId,
      ...(run.environmentId ? { environmentId: run.environmentId } : {}),
      status: run.status,
      template: {
        id: plan.template.id,
        revision: plan.template.revision,
        name: plan.template.name,
      },
      repeated: false,
    };
  }

  private repeated(run: GraphRun, request: GraphLaunchRequest): GraphLaunchResult {
    const scope = runScope(request.ref);
    const sameTemplate =
      run.projectId === request.projectId &&
      (run.template.scope ?? scope) === scope &&
      (request.ref.scope === "project" || run.template.id === request.ref.id);
    const sameEnvironment =
      request.environment.kind === "new"
        ? run.launch?.create === request.environment.create
        : run.environmentId === request.environment.environmentId;
    if (!sameTemplate || !sameEnvironment) {
      throw new GraphLaunchError(
        "conflict",
        "This requestId already launched a different run; use a new requestId",
      );
    }
    return {
      runId: run.id,
      projectId: run.projectId,
      ...(run.environmentId ? { environmentId: run.environmentId } : {}),
      status: run.status,
      template: {
        id: run.plan.template.id,
        revision: run.plan.template.revision,
        name: run.plan.template.name,
      },
      repeated: true,
    };
  }

  /**
   * The bindings for every role: the request's, else the defaults. Refuses
   * an unknown role, a panel size outside 1..`maxPanel`, a list for a
   * one-model role, a disabled provider, a provider that cannot return the
   * role's typed results and one that misses a node's floor.
   */
  private bindRoles(
    plan: CompiledGraphPlan,
    compiled: GraphTemplateCompileResponse,
    given: GraphRunBindings["roles"],
    defaults: GraphRunBindings["roles"],
    enabled: readonly AgentPlatform[],
  ): GraphRunBindings["roles"] {
    const declared = new Map(plan.roles.map((role) => [role.key, role]));
    for (const key of Object.keys(given)) {
      if (!declared.has(key))
        throw new GraphLaunchError("invalid-binding", `The template has no role ${key}`);
    }
    const nodes = agentNodes(plan);
    const roles: GraphRunBindings["roles"] = {};
    for (const role of plan.roles) {
      const binding = given[role.key] ?? defaults[role.key] ?? { platform: "claude" as const };
      const label = role.label ?? role.key;
      if (role.multiplicity === "one" && Array.isArray(binding)) {
        throw new GraphLaunchError("invalid-binding", `The role ${label} takes one model`);
      }
      const list = bindingList(binding);
      if (role.multiplicity === "panel" && (list.length < 1 || list.length > maxPanelOf(role))) {
        throw new GraphLaunchError(
          "invalid-binding",
          `The panel ${label} takes 1 to ${maxPanelOf(role)} models`,
        );
      }
      const bound = nodes.filter((node) => node.role === role.key);
      const choices = compiled.providerChoices?.find((entry) => entry.role === role.key);
      for (const member of list) {
        if (bound.length === 0) continue;
        if (!enabled.includes(member.platform)) {
          throw new GraphLaunchError(
            "invalid-binding",
            `${member.platform} is not enabled; choose another provider for ${label}`,
          );
        }
        const choice = choices?.choices.find((entry) => entry.platform === member.platform);
        if (choice && !choice.allowed) {
          throw new GraphLaunchError(
            "invalid-binding",
            `${member.platform} misses the enforcement floor of ${choice.blockedBy?.nodeId ?? label} (${choice.blockedBy?.tier ?? choice.tier} below ${choice.blockedBy?.floor ?? "the floor"})`,
          );
        }
        if (needsResults(bound) && !this.structuredResults(member.platform)) {
          throw new GraphLaunchError(
            "invalid-binding",
            `${member.platform} cannot return the typed results of ${label} on this host`,
          );
        }
      }
      roles[role.key] =
        role.multiplicity === "panel" ? list.map((entry) => ({ ...entry })) : { ...list[0]! };
    }
    // The same judgement dispatch makes (item 209), on the host as it is now.
    const host = this.deps.host?.();
    if (host) {
      const problems = graphBindingFloorProblems(plan, roles, host);
      if (problems.length > 0) throw new GraphLaunchError("invalid-binding", problems[0]!.message);
    }
    return roles;
  }

  private async defaultRoles(
    plan: CompiledGraphPlan,
    projectId: string,
    environment: Environment | null,
    enabled: readonly AgentPlatform[],
    saved: GraphLaunchDefaults | null,
  ): Promise<GraphRunBindings["roles"]> {
    let settings: AgentSettingsTiers = {};
    try {
      settings = await this.deps.settingsTiers(projectId, environment);
    } catch {
      settings = {};
    }
    const multiReview = resolveMultiReviewSettings(settings);
    const fromSettings = graphRoleDefaultBindings(plan.roles, {
      actionDefaults: resolveActionDefaults(settings),
      additionalReviewers: multiReview.additionalReviewers,
      reviewerLenses: multiReview.reviewerLenses,
      defaultAgent: resolveDefaultAgent(settings),
      enabledAgents: enabled,
    });
    // A saved binding stands while it still fits the role and every provider
    // it names is enabled; otherwise the settings default takes its place.
    const result: GraphRunBindings["roles"] = {};
    for (const role of plan.roles) {
      const kept = saved?.roles[role.key];
      const fits =
        kept !== undefined &&
        (role.multiplicity === "panel"
          ? Array.isArray(kept) && kept.length >= 1 && kept.length <= maxPanelOf(role)
          : !Array.isArray(kept)) &&
        bindingList(kept).every(
          (member) => isAgentPlatform(member.platform) && enabled.includes(member.platform),
        );
      result[role.key] = structuredClone(fits ? kept! : fromSettings[role.key]!);
    }
    return result;
  }

  /**
   * Fills each empty `workspace@1` run input from the existing environment's
   * branch and HEAD. A new environment has no commit yet: the provisioner
   * stores them once it exists.
   */
  private async fillWorkspaceInputs(
    plan: CompiledGraphPlan,
    inputs: Record<string, unknown>,
    environment: Environment | null,
  ): Promise<void> {
    const empty = plan.inputs.filter(
      (entry) => entry.type === "workspace@1" && !(entry.name in inputs),
    );
    if (empty.length === 0) return;
    // A new environment's HEAD is stored once it exists (the provisioner).
    if (!environment) return;
    if (!this.deps.workspaceHead) {
      const required = empty.find((entry) => entry.required);
      if (required) {
        throw new GraphLaunchError("invalid-launch", `The run input ${required.name} is required`);
      }
      return;
    }
    let head: { branch: string; headRef: string };
    try {
      head = await this.deps.workspaceHead(environment);
    } catch {
      throw new GraphLaunchError(
        "invalid-launch",
        "The environment's current commit could not be read; start the environment and try again",
      );
    }
    for (const entry of empty) {
      inputs[entry.name] = { branch: head.branch, headRef: head.headRef, baseRef: null };
    }
  }

  private structuredResults(platform: AgentPlatform): boolean {
    return this.deps.structuredResults?.(platform) ?? true;
  }

  private async ticketValue(taskId: string, projectId: string): Promise<unknown> {
    const task = await this.deps.storage.kanban.getKanbanTask(taskId);
    if (!task || task.projectId !== projectId) {
      throw new GraphLaunchError("not-found", "The ticket does not exist in this project");
    }
    const content = normalizeTicketContent(task, { now: task.createdAt });
    const criteria = (content.sections.acceptanceCriteria ?? []).slice(
      0,
      TICKET_SECTION_LIMITS.maxAcceptanceCriteria,
    );
    const snapshot: TaskSnapshot = {
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      comments: task.comments.map((comment) => ({ text: comment.text })),
      images: [],
      ...(content.kind ? { kind: content.kind } : {}),
      acceptanceCriteriaItems: criteria.map(({ id, text }) => ({ id, text })),
    };
    return graphTicketFromTaskSnapshot(snapshot);
  }

  // ------------------------------------------------------------ cleanup

  /**
   * Removes runs that ended before they had an environment beyond the
   * retention bounds (20 per project, 7 days). Concurrent calls share one
   * sweep. Returns how many were removed.
   */
  sweep(): Promise<number> {
    this.sweeping ??= this.sweepOnce().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<number> {
    const now = this.clock().getTime();
    const runs = (await this.deps.storage.graphRuns.listAllGraphRuns()).filter(
      // Mock runs have their own retention (item 213).
      (run) => run.environmentId === undefined && !run.mock && isGraphRunTerminal(run.status),
    );
    const byProject = new Map<string, GraphRun[]>();
    for (const run of runs) {
      const list = byProject.get(run.projectId) ?? [];
      list.push(run);
      byProject.set(run.projectId, list);
    }
    const expired: string[] = [];
    for (const list of byProject.values()) {
      list.sort((a, b) => endedAt(b).localeCompare(endedAt(a)));
      list.forEach((run, index) => {
        const age = now - Date.parse(endedAt(run));
        if (
          index >= GRAPH_LAUNCH_BOUNDS.maxEnvironmentlessRunsPerProject ||
          age > GRAPH_LAUNCH_BOUNDS.environmentlessRunRetentionMs
        ) {
          expired.push(run.id);
        }
      });
    }
    let removed = 0;
    for (const runId of expired) {
      try {
        if (await this.deps.storage.graphRuns.deleteEnvironmentlessGraphRun(runId)) removed += 1;
      } catch {
        // It got an environment or was restarted meanwhile: not ours to remove.
      }
    }
    if (removed > 0) {
      console.info(`[graphs] Removed ${removed} runs that ended without an environment`);
    }
    return removed;
  }

  // ------------------------------------------------------------ helpers

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.deps.storage.getProject(projectId);
    if (!project) throw new GraphLaunchError("not-found", "The project does not exist");
    return project;
  }

  private async requireEnvironment(environmentId: string, projectId: string): Promise<Environment> {
    const environment = await this.deps.storage.getEnvironment(environmentId);
    if (!environment || environment.deletionRequestedAt) {
      throw new GraphLaunchError("not-found", "The environment does not exist");
    }
    if (environment.projectId !== projectId) {
      invalid("The environment belongs to another project");
    }
    return environment;
  }

  /**
   * The policy the run's agents get: an existing environment's own, else the
   * one a new environment of `create`'s kind gets (a restricted container or
   * a worktree), else the compiler's design-time default.
   */
  private async launchPolicy(
    environment: Environment | null,
    create: "worktree" | "container" | null,
  ): Promise<NativeAgentExecutionPolicy | undefined> {
    if (environment) return resolveEnvironmentExecutionPolicy(environment, "build-pipeline");
    if (!create) return undefined;
    return resolveEnvironmentExecutionPolicy(
      {
        environmentType: create === "container" ? "containerized" : "local",
        networkAccessMode: create === "container" ? "restricted" : "full",
        agentSettings: undefined,
      } as Pick<Environment, "environmentType" | "networkAccessMode" | "agentSettings">,
      "build-pipeline",
    );
  }

  private async enabledProviders(): Promise<AgentPlatform[]> {
    try {
      const enabled = (await this.deps.storage.loadConfig()).global.enabledAgentPlatforms ?? [];
      const platforms = enabled.filter(isAgentPlatform);
      return platforms.length > 0 ? [...new Set(platforms)] : [...AGENT_PLATFORMS];
    } catch {
      return [...AGENT_PLATFORMS];
    }
  }
}

function endedAt(run: GraphRun): string {
  return run.finishedAt ?? run.updatedAt;
}
