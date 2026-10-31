import { createHash } from "node:crypto";
import {
  COORDINATOR_MAIL_ADDRESS,
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import {
  controlMcpActionAllowed,
  type ControlMcpCredentialPolicy,
} from "@orkestrator/protocol/control-mcp";
import {
  isPublicActionName,
  PUBLIC_ACTIONS,
  PUBLIC_API_SCHEMA_VERSION,
  type PublicActionName,
  type PublicActionResponse,
} from "@orkestrator/protocol/public-api";
import { PUBLIC_ACTION_INPUTS } from "@orkestrator/protocol/public-api-inputs";
import { encodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import {
  SCHEDULED_JOB_LIMITS,
  scheduleAccountSwitchGrant,
  type ScheduleAction,
  type ScheduleFire,
  type ScheduleFireOutcome,
  type ScheduleOwner,
  type ScheduledJob,
} from "@orkestrator/protocol/scheduled-jobs";
import type {
  GraphLaunchOptions,
  GraphLaunchOrigin,
  GraphLaunchRequest,
  GraphLaunchResult,
} from "@orkestrator/protocol/graphs/launch";
import type { GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import type { CoordinatorControlScope } from "../control-mcp-tools.js";
import { coordinatorRoleCapabilities } from "../control-mcp-tools.js";
import type { InProcessToolInfo, InProcessToolResult } from "../mcp-in-process.js";
import { withPublicAuthority } from "../public-api/dispatch.js";
import { controlMcpAuthority, type PublicAuthority } from "../public-api/operation-ledger.js";
import type { PublicActionHandler } from "../public-api/types.js";
import type { FireResult } from "./model.js";
import { isReminderToSelf } from "./reminders.js";

/**
 * Runs a schedule's action as its owner, and checks at creation that the
 * owner could run it at all. Nothing here widens authority:
 *
 * - The operator and Control MCP credentials go through `public_action` under
 *   their own authority (`operator`, `control-mcp:<id>`), with the
 *   credential's capability rule re-checked at every fire.
 * - Agents and coordinators call their own MCP tools in-process with the
 *   scope the HTTP endpoint would have authenticated for them, so the tool's
 *   validation and the command-boundary checks are the ones that apply.
 *
 * The one addition is a reminder to oneself. No tab may mail its own
 * mailbox, so "wake me at 03:12" is delivered as a backend notice (a system
 * sender, like a workflow status notice) to the owner's own mailbox. It can
 * only ever reach the owner.
 *
 * Every dispatch carries the request key `sched:<fireId>`. A fire re-run
 * after a backend restart therefore replays the first attempt's outcome
 * instead of acting twice.
 */

export interface ScheduledJobRuntime {
  /** The backend command registry, as the operator. */
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  storage: {
    sendAgentMail(
      sender: { kind: "system"; projectId: string; source: "workflow"; resourceId: string },
      input: {
        requestId: string;
        toEnvironmentId: string;
        toTabId: string;
        subject?: string;
        body: string;
      },
    ): Promise<{ id: string; toEnvironmentId: string; toTabId: string }>;
    coordinators: {
      getCoordinatorWorkspace(projectId: string): Promise<CoordinatorWorkspace | null>;
    };
  };
  /** The public handler table, used to check an action's input without running it. */
  publicHandlers?: () => readonly PublicActionHandler[];
  controlMcp?: {
    credentialPolicy(credentialId: string): ControlMcpCredentialPolicy | null;
    callCoordinatorTool(
      scope: CoordinatorControlScope,
      tool: string,
      args: Record<string, unknown>,
    ): Promise<InProcessToolResult>;
    listCoordinatorTools(scope: CoordinatorControlScope): Promise<InProcessToolInfo[]>;
  };
  /** The graph launch service (item 214), for `graph` actions. */
  graphs?: {
    launch(request: GraphLaunchRequest, origin: GraphLaunchOrigin): Promise<GraphLaunchResult>;
    options(input: {
      ref: GraphTemplateRef;
      projectId: string;
      environmentId?: string;
      create?: "worktree" | "container";
    }): Promise<GraphLaunchOptions>;
  };
  agentTools?: {
    callTool(
      scope: { environmentId: string; projectId: string; tabId: string },
      tool: string,
      args: Record<string, unknown>,
    ): Promise<InProcessToolResult>;
    listTools(scope: {
      environmentId: string;
      projectId: string;
      tabId: string;
    }): Promise<InProcessToolInfo[]>;
  };
}

type LaunchBase = { baseBranch: string; baseCommit: string };
type PersistLaunchBase = (base: LaunchBase) => void | Promise<void>;

export class ScheduleAuthorityError extends Error {}

/** Tools a schedule may never call: scheduling from a schedule, and reads. */
export const SCHEDULE_TOOL_NAMES = [
  "create_schedule",
  "list_schedules",
  "cancel_schedule",
  "pause_schedule",
  "resume_schedule",
  "update_schedule",
] as const;

const RETRYABLE_PUBLIC_CODES = new Set(["busy", "not-ready", "dispatch-parked"]);

export function fireRequestId(fire: Pick<ScheduleFire, "fireId">): string {
  return `sched:${fire.fireId}`;
}

function bounded(message: string, limit = 500): string {
  const trimmed = message.replace(/\s+/g, " ").trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function errorMessage(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The owner tool a schedule action calls (agents and coordinators). */
function ownerTool(action: Extract<ScheduleAction, { kind: "action" }>): string {
  return action.action === "mail.send" ? "send_message" : action.action;
}

/** Whether firing `action` for `input` would need a confirmation nobody can give at fire time. */
function needsConfirmation(action: PublicActionName, input: Record<string, unknown>): boolean {
  const contract = PUBLIC_ACTION_INPUTS[action];
  if (contract.confirmation !== "always") return false;
  if (contract.confirmWhen === "discard") return input.discard === true;
  return true;
}

function publicCall(
  action: ScheduleAction,
): { action: PublicActionName; input: Record<string, unknown> } | null {
  switch (action.kind) {
    case "action":
      return isPublicActionName(action.action)
        ? { action: action.action, input: action.input }
        : null;
    case "prompt":
      return {
        action: "session.prompt",
        input: {
          sessionId: encodePublicSessionId(action.environmentId, action.tabId),
          prompt: action.prompt,
          ...(action.mode ? { mode: action.mode } : {}),
        },
      };
    case "launch":
      return { action: "environment.launch", input: launchInput(action) };
    case "graph":
      // A graph launch goes through the graph launch service, not `public_action`.
      return null;
  }
}

const GRAPH_OWNER_REFUSAL =
  "Only the app and the CLI schedule a graph action; a coordinator schedules its own launch_graph tool";

/** Graph launch refusals that mean the target is gone. */
const GRAPH_TARGET_GONE = new Set(["not-found"]);
/** Graph launch refusals a later attempt can outgrow. */
const GRAPH_RETRYABLE = new Set(["disabled"]);

function launchInput(action: Extract<ScheduleAction, { kind: "launch" }>): Record<string, unknown> {
  return {
    projectId: action.projectId,
    type: action.type ?? "local",
    agent: action.agent,
    prompt: action.prompt,
    ...(action.name ? { name: action.name } : {}),
    ...(action.model ? { model: action.model } : {}),
    ...(action.reasoning ? { reasoning: action.reasoning } : {}),
    ...(action.mode ? { mode: action.mode } : {}),
    ...(action.baseBranch ? { baseBranch: action.baseBranch } : {}),
    ...(action.baseCommit ? { baseCommit: action.baseCommit } : {}),
  };
}

export class ScheduledJobExecutor {
  constructor(private readonly runtime: ScheduledJobRuntime) {}

  // -------------------------------------------------------------------------
  // Creation-time checks

  /**
   * Refuses an action its owner could not perform directly. Run again at
   * every fire (the owner's rights may have changed since), so this is the
   * early, friendly half of the check.
   */
  async validate(owner: ScheduleOwner, action: ScheduleAction): Promise<void> {
    if (isReminderToSelf(owner, action)) return;
    if (action.kind === "graph") {
      await this.validateGraph(owner, action);
      return;
    }
    switch (owner.kind) {
      case "operator":
      case "control-mcp": {
        const call = publicCall(action);
        if (!call) {
          throw new ScheduleAuthorityError(
            `"${action.kind === "action" ? action.action : action.kind}" is not a public action`,
          );
        }
        this.assertPublicActionSchedulable(owner, call.action, call.input);
        if (action.kind !== "launch") this.assertParses(call.action, call.input);
        return;
      }
      case "agent": {
        if (action.kind !== "action") {
          throw new ScheduleAuthorityError(
            "Agents can schedule their own tools only (for example send_message); ask the coordinator or the user to schedule prompts and launches",
          );
        }
        if (!this.runtime.agentTools)
          throw new ScheduleAuthorityError("Agent tools are unavailable");
        const tools = await this.runtime.agentTools.listTools(owner);
        this.assertToolSchedulable(tools, ownerTool(action));
        return;
      }
      case "coordinator": {
        const scope = await this.coordinatorScope(owner);
        if (!this.runtime.controlMcp)
          throw new ScheduleAuthorityError("Control MCP is unavailable");
        const tools = await this.runtime.controlMcp.listCoordinatorTools(scope);
        const tool =
          action.kind === "action"
            ? ownerTool(action)
            : action.kind === "prompt"
              ? "send_prompt_to_tab"
              : "launch_environment";
        this.assertToolSchedulable(tools, tool);
        return;
      }
    }
  }

  /**
   * A `graph` action is the operator's (the app, the CLI): it runs through the
   * graph launch service as `requestedBy: "schedule"`. A coordinator schedules
   * its own `launch_graph` tool instead (`type: "tool"`), so the run is its
   * own and it gets the run's status wakes. The template must resolve and be
   * launchable now: trusted, not an engine template, compiling cleanly.
   * Never authoring.
   */
  private async validateGraph(
    owner: ScheduleOwner,
    action: Extract<ScheduleAction, { kind: "graph" }>,
  ): Promise<void> {
    if (owner.kind !== "operator") {
      throw new ScheduleAuthorityError(GRAPH_OWNER_REFUSAL);
    }
    if (!this.runtime.graphs) throw new ScheduleAuthorityError("Graph launches are unavailable");
    let options: GraphLaunchOptions;
    try {
      options = await this.runtime.graphs.options({
        ref: action.request.ref,
        projectId: action.request.projectId,
        ...(action.request.environment.kind === "existing"
          ? { environmentId: action.request.environment.environmentId }
          : { create: action.request.environment.create }),
      });
    } catch (error) {
      throw new ScheduleAuthorityError(`This graph cannot be launched: ${errorMessage(error)}`);
    }
    if (!options.launchable) {
      throw new ScheduleAuthorityError(
        `This graph cannot be launched: ${options.blockedReason ?? "it is not launchable"}`,
      );
    }
  }

  /** The operator's scheduled graph launch, through the launch service. */
  private async runGraph(job: ScheduledJob, fire: ScheduleFire): Promise<FireResult> {
    if (job.action.kind !== "graph") throw new Error("Not a graph launch");
    if (!this.runtime.graphs) {
      return {
        ok: false,
        error: { code: "unavailable", message: "Graph launches are unavailable" },
        retry: true,
      };
    }
    try {
      const launched = await this.runtime.graphs.launch(
        { ...job.action.request, requestId: fireRequestId(fire) },
        { requestedBy: "schedule", scheduleId: job.id },
      );
      return {
        ok: true,
        outcome: {
          runId: launched.runId,
          ...(launched.environmentId ? { environmentId: launched.environmentId } : {}),
          summary: `graph run ${launched.repeated ? "already launched" : "launched"} (${launched.status})`,
        },
      };
    } catch (error) {
      const code =
        isRecord(error) && typeof error.code === "string" ? error.code : "graph-launch-failed";
      return {
        ok: false,
        error: { code, message: errorMessage(error) },
        retry: GRAPH_RETRYABLE.has(code),
        ...(GRAPH_TARGET_GONE.has(code) ? { pause: "target-deleted" as const } : {}),
      };
    }
  }

  private assertPublicActionSchedulable(
    owner: Extract<ScheduleOwner, { kind: "operator" | "control-mcp" }>,
    action: PublicActionName,
    input: Record<string, unknown>,
  ): void {
    if (!PUBLIC_ACTIONS[action].mutation) {
      throw new ScheduleAuthorityError(
        `${action} is a read; schedule an action that changes something`,
      );
    }
    if (action.startsWith("schedule.")) {
      throw new ScheduleAuthorityError("A schedule cannot create or change schedules");
    }
    if (needsConfirmation(action, input)) {
      throw new ScheduleAuthorityError(
        `${action} always needs a confirmation, which nobody can give when a schedule fires`,
      );
    }
    if (owner.kind === "control-mcp") {
      const policy = this.runtime.controlMcp?.credentialPolicy(owner.credentialId);
      if (!policy) throw new ScheduleAuthorityError("This Control MCP credential no longer exists");
      if (!controlMcpActionAllowed(policy, action)) {
        throw new ScheduleAuthorityError(`This credential may not run ${action}`);
      }
    }
  }

  private assertParses(action: PublicActionName, input: Record<string, unknown>): void {
    const handler = this.runtime.publicHandlers?.().find((item) => item.action === action);
    if (!handler) return;
    try {
      handler.parse(input);
    } catch (error) {
      throw new ScheduleAuthorityError(`Invalid input for ${action}: ${errorMessage(error)}`);
    }
  }

  private assertToolSchedulable(tools: readonly InProcessToolInfo[], tool: string): void {
    if ((SCHEDULE_TOOL_NAMES as readonly string[]).includes(tool)) {
      throw new ScheduleAuthorityError("A schedule cannot create, change or cancel schedules");
    }
    const found = tools.find((item) => item.name === tool);
    if (!found)
      throw new ScheduleAuthorityError(`You cannot call ${tool}, so it cannot be scheduled`);
    if (found.readOnly) {
      throw new ScheduleAuthorityError(
        `${tool} only reads; schedule an action that changes something`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Fire time

  async execute(
    job: ScheduledJob,
    fire: ScheduleFire,
    persistBase: PersistLaunchBase,
  ): Promise<FireResult> {
    try {
      if (job.owner.kind === "agent" && this.runtime.agentTools) {
        try {
          await this.runtime.agentTools.listTools(job.owner);
        } catch (error) {
          if (isRecord(error) && error.code === "capability-denied") {
            throw new ScheduleAuthorityError(errorMessage(error));
          }
          throw error;
        }
      }
      if (isReminderToSelf(job.owner, job.action)) return await this.remind(job, fire);
      if (job.action.kind === "graph" && job.owner.kind === "operator") {
        return await this.runGraph(job, fire);
      }
      if (job.action.kind === "graph") throw new ScheduleAuthorityError(GRAPH_OWNER_REFUSAL);
      switch (job.owner.kind) {
        case "operator":
          return await this.runPublic(job, fire, "operator", undefined, persistBase);
        case "control-mcp": {
          const policy = this.runtime.controlMcp?.credentialPolicy(job.owner.credentialId);
          if (!policy) {
            return {
              ok: false,
              error: {
                code: "authority-lost",
                message: "The Control MCP credential that created this schedule was revoked",
              },
              pause: "authority-lost",
            };
          }
          return await this.runPublic(
            job,
            fire,
            controlMcpAuthority(job.owner.credentialId),
            policy,
            persistBase,
          );
        }
        case "agent":
          return await this.runAgentTool(job, fire, job.owner);
        case "coordinator":
          return await this.runCoordinatorTool(job, fire, job.owner, persistBase);
      }
    } catch (error) {
      if (error instanceof ScheduleAuthorityError) {
        return {
          ok: false,
          error: { code: "authority-lost", message: errorMessage(error) },
          pause: "authority-lost",
        };
      }
      if (error instanceof OwnerUnavailableError) {
        return {
          ok: false,
          error: { code: "owner-unavailable", message: errorMessage(error) },
          retry: true,
        };
      }
      return { ok: false, error: { code: "fire-failed", message: errorMessage(error) } };
    }
  }

  private async runPublic(
    job: ScheduledJob,
    fire: ScheduleFire,
    authority: PublicAuthority,
    policy: ControlMcpCredentialPolicy | undefined,
    persistBase: PersistLaunchBase,
  ): Promise<FireResult> {
    let action = job.action;
    const resolved: ScheduleFireOutcome = {};
    if (action.kind === "launch" && !action.baseCommit) {
      let branch = fire.outcome?.baseBranch;
      let commit = fire.outcome?.baseCommit;
      if (!branch || !commit) {
        const tip = await this.runtime.invoke<unknown>("get_project_base_branch_tip", {
          projectId: action.projectId,
          ...(action.baseBranch ? { branch: action.baseBranch } : {}),
        });
        commit = isRecord(tip) ? stringField(tip.commit) : undefined;
        branch = isRecord(tip) ? stringField(tip.branch) : undefined;
        if (!commit || !branch || (action.baseBranch && branch !== action.baseBranch)) {
          return {
            ok: false,
            error: {
              code: "base-unavailable",
              message: `Could not resolve the newest commit of ${action.baseBranch ?? "the base branch"}`,
            },
          };
        }
        await persistBase({ baseBranch: branch, baseCommit: commit });
      }
      action = { ...action, baseBranch: branch, baseCommit: commit };
      resolved.baseBranch = branch;
      resolved.baseCommit = commit;
    }
    const call = publicCall(action);
    if (!call)
      return { ok: false, error: { code: "invalid-action", message: "Not a public action" } };
    if (policy && !controlMcpActionAllowed(policy, call.action)) {
      return {
        ok: false,
        error: {
          code: "authority-lost",
          message: `The credential may no longer run ${call.action}`,
        },
        pause: "authority-lost",
      };
    }
    const response = await this.runtime.invoke<PublicActionResponse>(
      "public_action",
      withPublicAuthority(
        {
          schemaVersion: PUBLIC_API_SCHEMA_VERSION,
          action: call.action,
          actionVersion: PUBLIC_ACTIONS[call.action].version,
          input: call.input,
          request: { requestId: fireRequestId(fire) },
        },
        authority,
      ),
    );
    const outcome: ScheduleFireOutcome = { ...resolved };
    if (response.receipt?.operationId) outcome.operationId = response.receipt.operationId;
    if (response.ok) {
      Object.assign(outcome, idsFrom(response.result));
      outcome.summary = `${call.action} ${response.receipt?.state ?? "accepted"}`;
      return { ok: true, outcome };
    }
    const code = response.error.code;
    return {
      ok: false,
      error: { code, message: bounded(response.error.message) },
      retry: RETRYABLE_PUBLIC_CODES.has(code),
      ...(code === "not-found" && (job.action.kind === "prompt" || call.action === "mail.send")
        ? { pause: "target-deleted" as const }
        : {}),
      outcome,
    };
  }

  private async runAgentTool(
    job: ScheduledJob,
    fire: ScheduleFire,
    owner: Extract<ScheduleOwner, { kind: "agent" }>,
  ): Promise<FireResult> {
    if (job.action.kind !== "action") {
      throw new ScheduleAuthorityError("Agents can schedule their own tools only");
    }
    if (!this.runtime.agentTools) {
      return {
        ok: false,
        error: { code: "unavailable", message: "Agent tools are not running" },
        retry: true,
      };
    }
    const tool = ownerTool(job.action);
    if ((SCHEDULE_TOOL_NAMES as readonly string[]).includes(tool)) {
      throw new ScheduleAuthorityError("A schedule cannot create, change or cancel schedules");
    }
    const result = await this.runtime.agentTools.callTool(owner, tool, {
      ...job.action.input,
      requestId: fireRequestId(fire),
    });
    return toolOutcome(tool, result);
  }

  private async runCoordinatorTool(
    job: ScheduledJob,
    fire: ScheduleFire,
    owner: Extract<ScheduleOwner, { kind: "coordinator" }>,
    persistBase: PersistLaunchBase,
  ): Promise<FireResult> {
    if (!this.runtime.controlMcp) {
      return {
        ok: false,
        error: { code: "unavailable", message: "Control MCP is not running" },
        retry: true,
      };
    }
    const scope = await this.coordinatorScope(owner);
    const requestId = fireRequestId(fire);
    const action = job.action;
    let tool: string;
    let args: Record<string, unknown>;
    const resolved: ScheduleFireOutcome = {};
    if (action.kind === "action") {
      tool = ownerTool(action);
      args = { ...action.input, requestId };
    } else if (action.kind === "graph") {
      throw new ScheduleAuthorityError(GRAPH_OWNER_REFUSAL);
    } else if (action.kind === "prompt") {
      tool = "send_prompt_to_tab";
      args = {
        requestId,
        environmentId: action.environmentId,
        tabId: action.tabId,
        prompt: action.prompt,
        ...(action.mode ? { conversationMode: action.mode } : {}),
        ...(action.nodeId ? { nodeId: action.nodeId } : {}),
      };
    } else {
      const stored = fire.outcome;
      const base =
        stored?.baseBranch && stored.baseCommit
          ? { ok: true as const, baseBranch: stored.baseBranch, baseCommit: stored.baseCommit }
          : await this.coordinatorLaunchBase(scope, action);
      if (!base.ok)
        return { ok: false, error: { code: "base-unavailable", message: base.message } };
      await persistBase({ baseBranch: base.baseBranch, baseCommit: base.baseCommit });
      resolved.baseBranch = base.baseBranch;
      resolved.baseCommit = base.baseCommit;
      tool = "launch_environment";
      args = {
        requestId,
        projectId: action.projectId,
        environmentType: action.type === "container" ? "containerized" : "local",
        agent: action.agent,
        prompt: action.prompt,
        baseBranch: base.baseBranch,
        baseCommit: base.baseCommit,
        ...(action.name ? { name: action.name } : {}),
        ...(action.model ? { modelId: action.model } : {}),
        ...(action.reasoning ? { reasoningId: action.reasoning } : {}),
        ...(action.mode ? { conversationMode: action.mode } : {}),
        ...(action.nodeId ? { nodeId: action.nodeId } : {}),
      };
    }
    if ((SCHEDULE_TOOL_NAMES as readonly string[]).includes(tool)) {
      throw new ScheduleAuthorityError("A schedule cannot create, change or cancel schedules");
    }
    const result = await this.runtime.controlMcp.callCoordinatorTool(scope, tool, args);
    const outcome = toolOutcome(tool, result);
    outcome.outcome = { ...resolved, ...outcome.outcome };
    return outcome;
  }

  /**
   * The base a scheduled coordinator launch uses: a pinned commit as given,
   * otherwise the newest commit of the branch (the repository's base branch
   * by default) when the schedule fires.
   */
  private async coordinatorLaunchBase(
    scope: CoordinatorControlScope,
    action: Extract<ScheduleAction, { kind: "launch" }>,
  ): Promise<
    { ok: true; baseBranch: string; baseCommit: string } | { ok: false; message: string }
  > {
    if (action.baseBranch && action.baseCommit) {
      return { ok: true, baseBranch: action.baseBranch, baseCommit: action.baseCommit };
    }
    if (action.nodeId) {
      // Another node: its own default base, read the way the coordinator would.
      const options = await this.runtime.controlMcp!.callCoordinatorTool(
        scope,
        "get_launch_options",
        {
          projectId: action.projectId,
          nodeId: action.nodeId,
        },
      );
      const base = isRecord(options.structuredContent?.coordinatorBase)
        ? options.structuredContent.coordinatorBase
        : null;
      const branch = stringField(base?.baseBranch);
      const commit = stringField(base?.baseCommit);
      if (options.isError || !branch || !commit) {
        return { ok: false, message: "The node's base branch could not be resolved" };
      }
      if (action.baseBranch && action.baseBranch !== branch) {
        return {
          ok: false,
          message: `Only the node's base branch (${branch}) resolves at fire time; pin baseCommit to launch from ${action.baseBranch}`,
        };
      }
      return { ok: true, baseBranch: branch, baseCommit: commit };
    }
    const tip = await this.runtime.invoke<unknown>("get_project_base_branch_tip", {
      projectId: action.projectId,
      ...(action.baseBranch ? { branch: action.baseBranch } : {}),
    });
    const branch = isRecord(tip) ? stringField(tip.branch) : undefined;
    const commit = isRecord(tip) ? stringField(tip.commit) : undefined;
    if (!branch || !commit || (action.baseBranch && branch !== action.baseBranch)) {
      return {
        ok: false,
        message: `Could not resolve the newest commit of ${action.baseBranch ?? "the base branch"}`,
      };
    }
    return { ok: true, baseBranch: branch, baseCommit: commit };
  }

  /**
   * The scope a coordinator's schedule runs under. A main schedule follows
   * the project's main coordinator to whichever conversation holds it now; a
   * side schedule needs its own conversation still open.
   */
  async coordinatorScope(
    owner: Extract<ScheduleOwner, { kind: "coordinator" }>,
  ): Promise<CoordinatorControlScope> {
    const workspace = await this.runtime.storage.coordinators.getCoordinatorWorkspace(
      owner.projectId,
    );
    if (!workspace || workspace.id !== owner.coordinatorId) {
      throw new ScheduleAuthorityError(
        "The coordinator that created this schedule no longer exists",
      );
    }
    const conversation =
      owner.role === "main"
        ? coordinatorMainConversation(workspace)
        : workspace.conversations.find(
            (item) => item.id === owner.conversationId && !item.closedAt,
          );
    if (!conversation) {
      if (owner.role === "side") {
        throw new ScheduleAuthorityError(
          "The side conversation that created this schedule was closed",
        );
      }
      throw new OwnerUnavailableError("No main coordinator conversation is open");
    }
    return {
      role: "coordinator",
      projectId: owner.projectId,
      coordinatorId: owner.coordinatorId,
      conversationId: conversation.id,
      mailboxIncarnationId: conversation.mailboxIncarnationId,
      capabilities: coordinatorRoleCapabilities(owner.role),
    };
  }

  /** A reminder to the owner's own mailbox, as a backend notice. */
  private async remind(job: ScheduledJob, fire: ScheduleFire): Promise<FireResult> {
    if (job.action.kind !== "action") throw new Error("Only mail can be a reminder");
    const owner = job.owner;
    const body = stringField(job.action.input.body) ?? job.name;
    const subject = stringField(job.action.input.subject) ?? `Scheduled reminder: ${job.name}`;
    let destination: { projectId: string; environmentId: string; tabId: string };
    if (owner.kind === "agent") {
      destination = {
        projectId: owner.projectId,
        environmentId: owner.environmentId,
        tabId: owner.tabId,
      };
    } else if (owner.kind === "coordinator") {
      if (owner.role === "main") {
        // The coordinator address reaches whichever conversation is main now,
        // and starts one if none is open, as any agent mail to it does.
        await this.coordinatorScope(owner).catch((error: unknown) => {
          if (!(error instanceof OwnerUnavailableError)) throw error;
        });
        destination = {
          projectId: owner.projectId,
          environmentId: COORDINATOR_MAIL_ADDRESS,
          tabId: "",
        };
      } else {
        const scope = await this.coordinatorScope(owner);
        destination = {
          projectId: owner.projectId,
          environmentId: coordinatorRuntimeId(scope.coordinatorId, scope.conversationId),
          tabId: "",
        };
      }
    } else {
      throw new Error("Only agents and coordinators send reminders to themselves");
    }
    const grant = scheduleAccountSwitchGrant(job.action);
    const grantNote = grant
      ? `\n\nThe user asked for this in their own words: "${grant.userInstruction}". This timer carries their permission to switch the active ${grant.platforms.join(" or ")} account${grant.nodeIds?.length ? ` (also on node ${grant.nodeIds.join(", ")})` : ""} without asking again, for ${SCHEDULED_JOB_LIMITS.selfTimerGrantWindowMs / 3_600_000} hours after this reminder was delivered: pass scheduleId ${job.id} to switch_provider_account.`
      : "";
    const message = await this.runtime.storage.sendAgentMail(
      { kind: "system", projectId: destination.projectId, source: "workflow", resourceId: job.id },
      {
        requestId: fireRequestId(fire),
        toEnvironmentId: destination.environmentId,
        toTabId: destination.tabId,
        subject,
        body: `${body}${grantNote}\n\n(Scheduled by you: ${job.name}, schedule ${job.id}.)`,
      },
    );
    return {
      ok: true,
      outcome: {
        messageId: message.id,
        environmentId: message.toEnvironmentId,
        summary: "reminder delivered to your own inbox",
      },
    };
  }
}

export class OwnerUnavailableError extends Error {}

function idsFrom(result: unknown): ScheduleFireOutcome {
  if (!isRecord(result)) return {};
  const outcome: ScheduleFireOutcome = {};
  const messageId =
    stringField(result.messageId) ??
    (isRecord(result.message) ? stringField(result.message.id) : undefined);
  if (messageId) outcome.messageId = messageId;
  const environment = isRecord(result.environment) ? result.environment : null;
  const environmentId =
    stringField(result.environmentId) ??
    stringField(environment?.id) ??
    stringField(result.toEnvironmentId);
  if (environmentId) outcome.environmentId = environmentId;
  const sessionId = stringField(result.sessionId);
  if (sessionId) outcome.sessionId = sessionId;
  const runId = stringField(result.runId);
  if (runId) outcome.runId = runId;
  return outcome;
}

function toolOutcome(tool: string, result: InProcessToolResult): FireResult {
  if (result.isError) {
    const message = bounded(result.text || `${tool} failed`);
    const lower = message.toLowerCase();
    const retry =
      /\bbusy\b|not ready|still running|already has an open|waiting on|owner-unavailable/.test(
        lower,
      );
    const authority =
      /capability-denied|capability denied|cannot access|no longer valid|credential/.test(lower);
    return {
      ok: false,
      error: { code: authority ? "authority-lost" : "tool-error", message },
      retry,
      ...(authority ? { pause: "authority-lost" as const } : {}),
    };
  }
  let parsed: unknown = result.structuredContent;
  if (!parsed) {
    try {
      parsed = JSON.parse(result.text) as unknown;
    } catch {
      parsed = undefined;
    }
  }
  if (isRecord(parsed)) {
    const dispatch = stringField(parsed.outcome);
    const error = isRecord(parsed.error) ? parsed.error : null;
    const message =
      stringField(parsed.error) ?? stringField(error?.message) ?? stringField(parsed.message);
    if (
      parsed.ok === false ||
      parsed.error ||
      (tool === "send_prompt_to_tab" && dispatch !== "accepted")
    ) {
      const code =
        stringField(error?.code) ??
        (tool === "send_prompt_to_tab" ? `dispatch-${dispatch ?? "unknown"}` : "startup-failed");
      return {
        ok: false,
        error: { code, message: bounded(message ?? `${tool} ${dispatch ?? "failed"}`) },
        // Unknown admission is ambiguous: retain it without resubmitting.
        retry: dispatch !== "unknown" && /busy|not-ready|parked/.test(code),
        outcome: { ...idsFrom(parsed), summary: `${tool} ${dispatch ?? "failed"}` },
      };
    }
  } else if (tool === "send_prompt_to_tab") {
    return {
      ok: false,
      error: { code: "dispatch-unknown", message: "Prompt acceptance could not be confirmed" },
    };
  }
  return { ok: true, outcome: { ...idsFrom(parsed), summary: `${tool} succeeded` } };
}

/** A short stable id for a request key (owner + caller request id). */
export function requestDigest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
