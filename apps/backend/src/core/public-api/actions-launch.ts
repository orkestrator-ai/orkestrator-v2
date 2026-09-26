import { createHash } from "node:crypto";
import { canonicalJson, PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import {
  encodePublicSessionId,
  nativeTabLogicalSessionKey,
} from "@orkestrator/protocol/public-api-resources";
import {
  initialPromptRequestId,
  launchEnvironmentCreateInput,
  validateSelection,
} from "../control-shared-actions.js";
import { nativeAgentSessionStorageKey } from "../native-agent-service-shared.js";
import { requireEnvironment } from "./actions-discovery.js";
import {
  isSetupReady,
  parseCreateEnvironment,
  validateCreateEnvironment,
} from "./actions-environments.js";
import { parseAgentSelection, type AgentSelection } from "./actions-sessions.js";
import { runWithContinuation } from "./background.js";
import { boundedMessage, PublicActionError } from "./errors.js";
import { textInput } from "./input.js";
import type { PublicOperationRecord } from "./operation-ledger.js";
import { observeRun } from "./run-observer.js";
import { publicEnvironmentSummary } from "./summaries.js";
import type {
  MutationActionHandler,
  OperationPatch,
  PublicActionContext,
  PublicActionHandler,
} from "./types.js";

/**
 * `environment.launch`: create an environment whose startup agent receives
 * one first prompt, then start it. The backend owns the whole progression —
 * setup, then the startup reconciliation that dispatches exactly one initial
 * prompt under a stable request ID. The CLI never follows up with its own
 * `session.start`, which would send a second first prompt.
 *
 * Stages: creating → starting → setup → launching → executing (then the
 * prompt run is observed like any other).
 */

interface LaunchInput extends AgentSelection {
  projectId: string;
  type: "local" | "container";
  name?: string;
  baseBranch?: string;
  baseCommit?: string;
  networkAccessMode?: "restricted" | "full";
  prompt: string;
}

const environmentLaunch: MutationActionHandler<LaunchInput> = {
  kind: "mutation",
  action: "environment.launch",
  parse(input) {
    const base = parseCreateEnvironment(input, [
      "agent",
      "model",
      "reasoning",
      "fastMode",
      "mode",
      "prompt",
    ]);
    const selection = parseAgentSelection(input);
    const prompt = textInput(
      input,
      "prompt",
      PUBLIC_API_LIMITS.promptMaxChars,
      PUBLIC_API_LIMITS.promptMaxBytes,
    );
    const value: LaunchInput = { ...base, ...selection, prompt };
    return { value, scope: `project:${base.projectId}`, intent: value };
  },
  async prepare(input, context) {
    await validateCreateEnvironment(input, context);
    try {
      await validateSelection(context.invoke, {
        projectId: input.projectId,
        agent: input.agent,
        ...(input.model ? { modelId: input.model } : {}),
        ...(input.reasoning ? { reasoningId: input.reasoning } : {}),
        ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
      });
    } catch (error) {
      throw new PublicActionError("unsupported", boundedMessage(error));
    }
    return {
      resolved: { agent: input.agent, model: input.model ?? null, mode: input.mode ?? "build" },
      resources: { projectId: input.projectId },
      async execute(operation) {
        const record = operation.current();
        await operation.update({ stage: "creating" });
        const createInput = launchEnvironmentCreateInput({
          projectId: input.projectId,
          ...(input.name ? { name: input.name } : {}),
          ...(input.networkAccessMode ? { networkAccessMode: input.networkAccessMode } : {}),
          prompt: input.prompt,
          environmentType: input.type === "local" ? "local" : "containerized",
          agent: input.agent,
          ...(input.model ? { modelId: input.model } : {}),
          ...(input.reasoning ? { reasoningId: input.reasoning } : {}),
          ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
          conversationMode: input.mode ?? "build",
          ...(input.baseBranch
            ? { baseBranch: input.baseBranch, baseCommit: input.baseCommit }
            : {}),
        });
        const created = await context.invoke<{ id: string }>("create_environment", {
          ...createInput,
          initialAgentPlatform: input.agent,
          controlRequestId: `public:${record.requestKey}`,
          controlRequestFingerprint: createHash("sha256")
            .update(canonicalJson(createInput))
            .digest("hex"),
        });
        const environmentId = created.id;
        const sessionId = encodePublicSessionId(environmentId, "startup-agent");
        const resources = {
          environmentId,
          sessionId,
          tabId: "startup-agent",
          dispatchRequestId: initialPromptRequestId(environmentId),
        };
        await operation.update({
          stage: "starting",
          resources,
          dispatch: { state: "not-sent" },
          result: { environmentId, sessionId, runId: operation.operationId },
        });
        const environment = await requireEnvironment(context, environmentId);
        const result = {
          environment: publicEnvironmentSummary(environment),
          sessionId,
          runId: operation.operationId,
        };
        return runWithContinuation(
          operation,
          context.invoke("start_environment", { environmentId }),
          {
            runningStage: "starting",
            runningResult: result,
            onSuccess: () => ({ state: "running", stage: "setup", result, resources }),
            onFailure: (error) => ({
              // The environment exists; the first prompt was never sent.
              state: "partial",
              stage: "starting",
              result,
              resources,
              dispatch: { state: "not-sent" },
              error: { code: "setup-failed", message: boundedMessage(error) },
            }),
          },
        );
      },
    };
  },
};

/** Advance a launch from setup to its first prompt's run. */
export async function reconcileLaunch(
  record: PublicOperationRecord,
  context: PublicActionContext,
): Promise<OperationPatch | null> {
  const environmentId = record.resources.environmentId;
  if (!environmentId) {
    return record.generation !== context.generation
      ? {
          state: "interrupted",
          error: {
            code: "run-interrupted",
            message: "The backend restarted before the environment was created",
          },
        }
      : null;
  }
  const environment = await context.command.storage.getEnvironment(environmentId);
  if (!environment) {
    return {
      state: "interrupted",
      error: {
        code: "run-interrupted",
        message: "The environment was deleted before the first prompt ran",
      },
    };
  }
  if (record.stage === "starting" && record.generation === context.generation) return null;
  if (environment.setupPhase === "failed" || environment.status === "error") {
    return {
      state: "partial",
      dispatch: { state: "not-sent" },
      error: {
        code: "setup-failed",
        message: `${environment.lifecycleError ?? "Environment setup failed"}; the first prompt was not sent`,
      },
    };
  }
  if (!isSetupReady(environment)) {
    if (record.generation !== context.generation && environment.status !== "running") {
      return {
        state: "partial",
        dispatch: { state: "not-sent" },
        error: {
          code: "run-interrupted",
          message:
            "The backend restarted before setup finished; start the environment again to send the first prompt",
        },
      };
    }
    return null;
  }
  const requestId = initialPromptRequestId(environmentId);
  const agent =
    environment.startupAgentSession?.agent ?? (record.resolved?.agent as string | undefined);
  const logicalSessionKey = nativeTabLogicalSessionKey(environmentId, "startup-agent");
  const session = agent
    ? await context.command.storage.getNativeAgentSession(
        nativeAgentSessionStorageKey(environmentId, agent as never, logicalSessionKey),
      )
    : null;
  if (session?.dispatchedRequestIds?.includes(requestId)) {
    const next = { ...record, stage: "executing", dispatch: { state: "accepted" as const } };
    const observed = await observeRun(next, context);
    return { stage: "executing", dispatch: { state: "accepted" }, ...observed };
  }
  if (session?.pendingDispatch?.requestId === requestId) {
    return {
      stage: "executing",
      state: "unknown",
      dispatch: { state: "unknown", recoverable: true },
      error: {
        code: "dispatch-unknown",
        message: "The first prompt may have been received; retry or discard it",
      },
    };
  }
  if (environment.startupAgentSession?.status === "error") {
    return {
      state: "partial",
      dispatch: { state: "not-sent" },
      error: {
        code: "operation-failed",
        message:
          environment.startupAgentSession.error?.slice(0, 500) ??
          "The startup agent could not start",
      },
    };
  }
  return record.stage === "launching" ? null : { stage: "launching" };
}

export const LAUNCH_HANDLERS: PublicActionHandler[] = [environmentLaunch];
