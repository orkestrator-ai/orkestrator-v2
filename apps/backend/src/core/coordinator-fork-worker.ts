import { STARTUP_AGENT_TAB_ID } from "@orkestrator/protocol/tab-initial-prompt";
import { createHash, randomUUID } from "node:crypto";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  COORDINATOR_DELEGATION_PRESENTATION,
  createCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";
import { resolveStartupLaunchFromSettings } from "@orkestrator/protocol/startup-launch";
import type { CommandContext } from "./commands-context.js";
import { forkEnvironmentRecord } from "./commands-environment-fork.js";
import { asNonBlankString } from "./commands-helpers.js";
import { localReportInstruction } from "./commands-registry-coordinator.js";
import {
  coordinatorNodeTarget,
  recordOrigin,
  remoteReportInstruction,
  RETRY_SAME_REQUEST,
  startRemoteRequest,
  withRetryAdvice,
} from "./commands-registry-coordinator-nodes.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  actionHash,
  coordinatorCaller,
  withCoordinatorReceipt,
  type CoordinatorCaller,
} from "./coordinator-action-scope.js";
import type { Environment, EnvironmentType } from "./models.js";
import { optionalText, requireProjectWorker, surfaceRecord } from "./worker-surface-runs.js";

/**
 * `fork_worker` (coordinator gap item 5): a coordinator forks one of its
 * project's worker environments to try an alternative from where that worker
 * got to.
 *
 * What a fork copies is what the sidebar's Fork copies (`fork_environment`):
 * the worker's **committed** HEAD becomes the fork's base on a new branch,
 * with the worker's agent settings, network mode, allowed domains and ports.
 * Uncommitted changes and the worker's conversation are not copied, and the
 * fork does not keep the worker's build pipeline link, so it never appears to
 * own (or, when deleted, delete) that pipeline.
 *
 * The fork becomes a coordinator worker exactly as a `launch_environment`
 * worker does: a durable `environment` workflow association with its base
 * branch and commit and, when a prompt is given, the startup tab's delegated
 * initial prompt (`pendingAgentLaunch`, so setup idling cannot settle it) and
 * a delegation that wakes the coordinator once when that turn ends.
 *
 * With `nodeId` the receipt, association and delegation stay on this command
 * node; the node owning the worker forks it through `fork_controller_environment`.
 */

type JsonRecord = Record<string, unknown>;

const MAX_PROMPT_LENGTH = 100_000;
const COMMIT = /^[0-9a-f]{40}$/i;

export interface ForkWorkerLaunch {
  prompt?: string;
  agent?: AgentPlatform;
  modelId?: string;
  reasoningId?: string;
  conversationMode?: "plan" | "build";
}

export function parseForkWorkerLaunch(input: JsonRecord): ForkWorkerLaunch {
  const prompt = input.prompt;
  if (
    prompt !== undefined &&
    (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH)
  )
    throw new Error(`Expected a prompt of 1-${MAX_PROMPT_LENGTH} characters`);
  const agent = input.agent;
  if (agent !== undefined && !(AGENT_PLATFORMS as readonly unknown[]).includes(agent))
    throw new Error("Expected agent to be an agent platform");
  const conversationMode = input.conversationMode;
  if (conversationMode !== undefined && conversationMode !== "plan" && conversationMode !== "build")
    throw new Error("Expected conversationMode plan or build");
  const modelId = optionalText(input.modelId, "modelId", 500);
  const reasoningId = optionalText(input.reasoningId, "reasoningId", 100);
  if (reasoningId && !modelId) throw new Error("reasoningId requires modelId");
  if (typeof prompt !== "string" && (agent || modelId || conversationMode))
    throw new Error("agent, modelId, reasoningId and conversationMode need a prompt");
  return {
    ...(typeof prompt === "string" ? { prompt: prompt.trim() } : {}),
    ...(agent ? { agent: agent as AgentPlatform } : {}),
    ...(modelId ? { modelId } : {}),
    ...(reasoningId ? { reasoningId } : {}),
    ...(conversationMode ? { conversationMode } : {}),
  };
}

function environmentTypeOf(value: unknown, fallback: unknown): EnvironmentType {
  const type = value ?? fallback;
  if (type !== "local" && type !== "containerized")
    throw new Error("Expected environmentType local or containerized");
  return type;
}

/** Who the fork's delegation frame names; the report instruction differs per node. */
export interface ForkDelegationFrame {
  projectId: string;
  coordinatorId: string;
  conversationId: string;
  instruction: string;
}

/**
 * Fork a worker of `projectId` on this node, once per `controlRequestId`.
 *
 * A retry finds the fork the first attempt saved; nothing else in this
 * function has an effect before the record is saved.
 */
export async function forkWorkerEnvironment(
  context: CommandContext,
  input: {
    projectId: string;
    sourceEnvironmentId: unknown;
    environmentType?: unknown;
    controlRequestId: string;
    launch: ForkWorkerLaunch;
    delegation?: ForkDelegationFrame;
  },
  fork: typeof forkEnvironmentRecord = forkEnvironmentRecord,
): Promise<{ environment: Environment; agent: AgentPlatform | null }> {
  const source = await requireProjectWorker(context, input.projectId, input.sourceEnvironmentId);
  const type = environmentTypeOf(input.environmentType, source.environmentType);
  const existing = (await context.storage.getEnvironmentsByProject(input.projectId)).find(
    (environment) => environment.controlRequestId === input.controlRequestId,
  );
  if (existing)
    return { environment: existing, agent: existing.initialAgentPlatform ?? launchAgent(existing) };
  const { launch } = input;
  let agent: AgentPlatform | null = null;
  const tiers = launch.prompt
    ? {
        repository: (await context.storage.getRepositoryConfig(input.projectId)).agentSettings,
        global: (await context.storage.loadConfig()).global.agentSettings,
      }
    : null;
  const created = await fork(source, type, context, {
    keepBuildPipeline: false,
    prepare: (environment, base) => {
      environment.controlRequestId = input.controlRequestId;
      if (!launch.prompt || !tiers) return;
      // Omitted, the agent is the one this fork's settings start (the
      // worker's own, copied with its settings), as a startup tab would.
      agent =
        launch.agent ??
        resolveStartupLaunchFromSettings({ environment: environment.agentSettings, ...tiers })
          .agent;
      const settings = environment.agentSettings ?? {};
      // The delegated startup turn is a native session, as launch_environment's is.
      environment.agentSettings = {
        ...settings,
        defaultAgent: agent,
        platforms: {
          ...settings.platforms,
          [agent]: { ...settings.platforms?.[agent], mode: "native" },
        },
      };
      const delegated = input.delegation
        ? createCoordinatorDelegatedPrompt(
            { ...input.delegation, baseBranch: base.branch, baseCommit: base.commit },
            launch.prompt,
          )
        : null;
      environment.initialPrompt = delegated?.source ?? launch.prompt;
      if (delegated)
        environment.initialPromptPresentation = {
          kind: COORDINATOR_DELEGATION_PRESENTATION,
          frame: delegated.frame,
        };
      environment.pendingAgentLaunch = true;
      environment.initialAgentPlatform = agent;
      environment.initialAgentModel = launch.modelId;
      environment.initialReasoningEffort = launch.reasoningId;
      environment.initialConversationMode = launch.conversationMode ?? "build";
    },
  });
  const environment = await context.storage.getEnvironment(created.id);
  if (!environment) throw new Error("The fork was not saved");
  return { environment, agent };
}

function launchAgent(environment: Environment): AgentPlatform | null {
  return environment.agentSettings?.defaultAgent ?? null;
}

/** A stable ID per coordinator request, so a retry finds what the first attempt made. */
function requestKey(caller: CoordinatorCaller, requestId: string): string {
  return createHash("sha256")
    .update(`${caller.coordinatorId}\0${requestId}`)
    .digest("hex")
    .slice(0, 24);
}

/** The part of a fork the coordinator is told; content-free (no prompt). */
function forkSummary(environment: JsonRecord): JsonRecord {
  return {
    environmentId: environment.id,
    name: environment.name,
    branch: environment.branch,
    environmentType: environment.environmentType,
    baseBranch: environment.delegationBaseBranch,
    baseCommit: environment.delegationBaseCommit,
  };
}

export function registerCoordinatorForkWorker(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "commands">,
): void {
  const run = async <T>(context: CommandContext, command: string, args: JsonRecord): Promise<T> => {
    const handler = dependencies.commands.get(command);
    if (!handler) throw new Error(`Backend command is unavailable: ${command}`);
    return (await handler(args, context)) as T;
  };

  register("fork_coordinator_worker", async (args, context) => {
    const caller = await coordinatorCaller(args.scope, context);
    const input = surfaceRecord(args.input, "the fork input");
    const requestId = asNonBlankString(input.requestId, "requestId");
    const sourceEnvironmentId = asNonBlankString(input.environmentId, "environmentId");
    const nodeId = optionalText(input.nodeId, "nodeId", 200);
    const launch = parseForkWorkerLaunch(input);
    const remote =
      nodeId && (await context.nodes?.status())?.nodeId !== nodeId
        ? await coordinatorNodeTarget(context, caller.projectId, nodeId)
        : undefined;
    const source = remote
      ? await remote.environment(sourceEnvironmentId)
      : await requireProjectWorker(context, caller.projectId, sourceEnvironmentId);
    const environmentType = environmentTypeOf(input.environmentType, source.environmentType);
    // The prompt is hashed, never stored in the receipt.
    const payload = {
      sourceEnvironmentId,
      environmentType,
      ...launch,
      ...(remote ? { nodeId: remote.nodeId } : {}),
    };
    return withCoordinatorReceipt(
      context,
      caller,
      { requestId, action: "fork-worker", payload },
      async () => {
        const key = requestKey(caller, requestId);
        const controlRequestId = `coordinator-fork:${key}`;
        let environment: JsonRecord;
        let agent: unknown;
        if (remote) {
          const forked = await withRetryAdvice(RETRY_SAME_REQUEST, () =>
            remote.call<JsonRecord>(
              "fork_controller_environment",
              {
                projectId: remote.projectId,
                environmentId: sourceEnvironmentId,
                environmentType,
                controlRequestId,
                launch,
                ...(launch.prompt
                  ? {
                      delegation: {
                        ...caller,
                        instruction: remoteReportInstruction(remote.nodeName),
                      },
                    }
                  : {}),
              },
              `fork:${caller.coordinatorId}:${requestId}`,
            ),
          );
          if (!forked || typeof forked.environment !== "object" || !forked.environment)
            throw new Error("The fork on that node returned no environment.");
          environment = forked.environment as JsonRecord;
          agent = forked.agent;
          if (typeof environment.id !== "string")
            throw new Error("The fork on that node returned no environment.");
          await recordOrigin(context, caller, remote, environment.id);
        } else {
          const forked = await forkWorkerEnvironment(context, {
            projectId: caller.projectId,
            sourceEnvironmentId,
            environmentType,
            controlRequestId,
            launch,
            ...(launch.prompt
              ? { delegation: { ...caller, instruction: localReportInstruction() } }
              : {}),
          });
          environment = forked.environment as unknown as JsonRecord;
          agent = forked.agent;
        }
        const environmentId = environment.id as string;
        const baseBranch = environment.delegationBaseBranch;
        const baseCommit = environment.delegationBaseCommit;
        if (
          typeof baseBranch !== "string" ||
          typeof baseCommit !== "string" ||
          !COMMIT.test(baseCommit)
        )
          throw new Error("The fork has no recorded base branch and commit");
        // The same durable association a launch_environment worker has.
        const association = await context.storage.coordinators.saveCoordinatorWorkflowAssociation({
          id: randomUUID(),
          ...caller,
          kind: "environment",
          resourceId: environmentId,
          ...(remote ? { nodeId: remote.nodeId } : {}),
          requestId: `fork:${requestId}`,
          payloadHash: actionHash(payload),
          baseBranch,
          baseCommit,
          createdAt: new Date().toISOString(),
        });
        let startError: string | undefined;
        if (environment.status !== "running" && environment.status !== "creating") {
          try {
            if (remote) await remote.call("start_environment_background", { environmentId });
            else await run(context, "start_environment_background", { environmentId });
          } catch (error) {
            startError = error instanceof Error ? error.message : "Environment start failed";
            if (remote && (error as { code?: unknown }).code === "outcome-unknown") {
              const current = await remote.environment(environmentId).catch(() => null);
              if (current?.status === "running" || current?.status === "creating")
                startError = undefined;
            }
          }
        }
        let coordinatorDelegationOpened = false;
        // Only a started fork owes this conversation an answer.
        if (launch.prompt && !startError) {
          coordinatorDelegationOpened =
            (
              await context.storage.coordinators.openCoordinatorDelegation(
                association.id,
                STARTUP_AGENT_TAB_ID,
              )
            )?.delegation?.state === "running";
          if (remote)
            await startRemoteRequest(context, caller, association.id, {
              nodeId: remote.nodeId,
              environmentId,
              tabId: STARTUP_AGENT_TAB_ID,
            });
        }
        return {
          ...forkSummary(environment),
          forkedFromEnvironmentId: sourceEnvironmentId,
          ...(remote ? { nodeId: remote.nodeId } : {}),
          status: startError ? "created" : "accepted",
          ...(launch.prompt ? { tabId: STARTUP_AGENT_TAB_ID, agent: agent ?? null } : {}),
          coordinatorDelegationOpened,
          ...(startError ? { startError } : {}),
        };
      },
    );
  });

  /** The fork on the node owning the worker, for a command node's coordinator. */
  register("fork_controller_environment", async (args, context) => {
    const projectId = asNonBlankString(args.projectId, "projectId");
    const controlRequestId = asNonBlankString(args.controlRequestId, "controlRequestId");
    if (!/^coordinator-fork:[0-9a-f]{24}$/.test(controlRequestId))
      throw new Error("Expected a coordinator fork request ID");
    const launch = parseForkWorkerLaunch(surfaceRecord(args.launch ?? {}, "launch"));
    const frame = args.delegation;
    let delegation: ForkDelegationFrame | undefined;
    if (frame !== undefined) {
      const value = surfaceRecord(frame, "delegation");
      delegation = {
        projectId: asNonBlankString(value.projectId, "delegation.projectId"),
        coordinatorId: asNonBlankString(value.coordinatorId, "delegation.coordinatorId"),
        conversationId: asNonBlankString(value.conversationId, "delegation.conversationId"),
        instruction: asNonBlankString(value.instruction, "delegation.instruction").slice(0, 4_000),
      };
    }
    const { environment, agent } = await forkWorkerEnvironment(context, {
      projectId,
      sourceEnvironmentId: args.environmentId,
      environmentType: args.environmentType,
      controlRequestId,
      launch,
      ...(delegation ? { delegation } : {}),
    });
    return {
      environment: {
        id: environment.id,
        name: environment.name,
        branch: environment.branch,
        environmentType: environment.environmentType,
        status: environment.status,
        delegationBaseBranch: environment.delegationBaseBranch,
        delegationBaseCommit: environment.delegationBaseCommit,
      },
      agent,
    };
  });
}
