// Session Manager Service
// Handles session state and interacts with Claude Agent SDK

import type { ModelInfo as SdkModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { controlOnlyQuery } from "./control-only-query.js";
import { liveInitializationResult, readFromLiveClaude } from "./live-claude-control.js";
import type {
  ModelInfo,
  QuestionRequest,
  PlanApprovalRequest,
  ClaudeInteractionRequest,
  ClaudeInteractionResponse,
  SessionInitData,
} from "../types/index.js";
import { CLAUDE_FALLBACK_MODEL_CATALOG } from "@orkestrator/protocol/claude-model-catalog";
import { eventEmitter } from "./event-emitter.js";
import { debugLog } from "./logger.js";
import { readFile } from "node:fs/promises";

import { interactionKey } from "./session-manager-interaction-budget.js";
import { isValidClaudeFormContent } from "./claude-elicitation-schema.js";
import * as lifecycle from "./session-manager-lifecycle.js";
import {
  claudeExecutableOptions,
  execFileText,
  interactionResolvers,
  pendingInteractions,
  pendingPlanApprovals,
  pendingQuestions,
  planApprovalResolvers,
  questionResolvers,
  sessions,
} from "./session-manager-core.js";
import { isPendingInteractionFor } from "./session-manager-lifecycle.js";
/**
 * Answer a pending question
 * @param requestId - The question request ID
 * @param answers - Record mapping question text to selected answer text
 */
export function answerQuestion(requestId: string, answers: Record<string, string>): boolean {
  const question = pendingQuestions.get(requestId);
  if (!question) {
    debugLog("[session-manager] Question not found for requestId:", requestId);
    return false;
  }

  console.log("[session-manager] Answering question", {
    requestId,
    answerCount: Object.keys(answers).length,
  });

  const resolver = questionResolvers.get(requestId);
  if (resolver) {
    debugLog("[session-manager] Resolving promise for question:", requestId);
    resolver.resolve(answers);
    questionResolvers.delete(requestId);
  } else {
    debugLog("[session-manager] No resolver found for question:", requestId);
  }

  pendingQuestions.delete(requestId);

  eventEmitter.emit({
    type: "question.answered",
    sessionId: question.sessionId,
    data: { requestId, answers },
  });

  return true;
}

/**
 * Dismiss a pending question and release the SDK callback waiting for it.
 */
export function dismissQuestion(requestId: string): boolean {
  const question = pendingQuestions.get(requestId);
  if (!question) {
    return false;
  }

  const resolver = questionResolvers.get(requestId);
  if (resolver) {
    resolver.reject(new Error("User dismissed the question"));
    questionResolvers.delete(requestId);
  }
  pendingQuestions.delete(requestId);

  eventEmitter.emit({
    type: "question.answered",
    sessionId: question.sessionId,
    data: { requestId, dismissed: true },
  });

  return true;
}

/**
 * Get pending questions for a session
 */
export function getPendingQuestions(sessionId?: string): QuestionRequest[] {
  const questions = Array.from(pendingQuestions.values());
  if (sessionId) {
    return questions.filter((q) => isPendingInteractionFor(q, sessionId));
  }
  return questions;
}

/**
 * Respond to a pending plan approval request
 * @param requestId - The plan approval request ID
 * @param approved - Whether the user approved the plan
 * @param feedback - Optional feedback message from the user (used when rejecting)
 */
export function respondToPlanApproval(
  requestId: string,
  approved: boolean,
  feedback?: string,
): boolean {
  const approval = pendingPlanApprovals.get(requestId);
  if (!approval) {
    debugLog("[session-manager] Plan approval not found for requestId:", requestId);
    return false;
  }
  if (approved && !isPlanApprovalActionable(approval)) {
    debugLog("[session-manager] Refusing incomplete plan approval", { requestId });
    return false;
  }

  console.log("[session-manager] Responding to plan approval", {
    requestId,
    approved,
    hasFeedback: typeof feedback === "string" && feedback.length > 0,
  });

  const resolver = planApprovalResolvers.get(requestId);
  if (resolver) {
    debugLog("[session-manager] Resolving promise for plan approval:", requestId);
    resolver.resolve({ approved, feedback });
    planApprovalResolvers.delete(requestId);
  } else {
    debugLog("[session-manager] No resolver found for plan approval:", requestId);
  }

  pendingPlanApprovals.delete(requestId);

  eventEmitter.emit({
    type: "plan.approval-responded",
    sessionId: approval.sessionId,
    data: { requestId, approved, feedback },
  });

  return true;
}

/** A positive response is valid only for a complete provider-captured plan. */
export function isPlanApprovalActionable(approval: PlanApprovalRequest): boolean {
  return (
    typeof approval.plan === "string" &&
    approval.plan.trim().length > 0 &&
    approval.planTruncated !== true
  );
}

/**
 * Get pending plan approvals for a session
 */
export function getPendingPlanApprovals(sessionId?: string): PlanApprovalRequest[] {
  const approvals = Array.from(pendingPlanApprovals.values());
  if (sessionId) {
    return approvals.filter((a) => isPendingInteractionFor(a, sessionId));
  }
  return approvals;
}

/**
 * Answer a parked MCP elicitation or tool approval. The callback that parked
 * it turns the answer into what the CLI expects.
 */
export function respondToInteraction(
  requestId: string,
  response: ClaudeInteractionResponse,
  sessionId?: string,
): boolean {
  const matches = Array.from(pendingInteractions.values()).filter(
    (entry) => entry.id === requestId && (sessionId === undefined || entry.sessionId === sessionId),
  );
  if (matches.length !== 1) return false;
  const request = matches[0]!;
  const key = interactionKey(request.sessionId, requestId);
  const resolve = interactionResolvers.get(key);
  if (!resolve) return false;
  if (
    response.action === "accept" &&
    request.kind === "mcp-form" &&
    !isValidClaudeFormContent(request.schema, response.content)
  )
    return false;
  // Removed here rather than by the parking callback, which resumes a tick
  // later: a read in between must not serve a card that is already answered.
  pendingInteractions.delete(key);
  interactionResolvers.delete(key);
  resolve(response);
  if (response.action === "cancel") lifecycle.abortSession(request.sessionId);
  return true;
}

/** Parked MCP elicitations and tool approvals, for one session or all. */
export function getPendingInteractions(sessionId?: string): ClaudeInteractionRequest[] {
  const interactions = Array.from(pendingInteractions.values());
  if (sessionId) {
    return interactions.filter((interaction) => isPendingInteractionFor(interaction, sessionId));
  }
  return interactions;
}

/**
 * Get session initialization data (MCP servers, plugins, slash commands)
 */
export function getSessionInitData(sessionId: string): SessionInitData | undefined {
  const session = sessions.get(sessionId);
  return session?.initData;
}

function catalogModels(models: readonly SdkModelInfo[]): ModelInfo[] {
  return models.map((model) => ({
    id: model.value,
    resolvedModel: model.resolvedModel,
    name: model.displayName,
    description: model.description,
    supportsFastMode: model.supportsFastMode,
    supportsEffort: model.supportsEffort,
    supportedEffortLevels: model.supportedEffortLevels,
    supportsAdaptiveThinking: model.supportsAdaptiveThinking,
    supportsAutoMode: model.supportsAutoMode,
  }));
}

/**
 * The models a running CLI listed in its initialize answer, if one is running.
 *
 * An empty or malformed list is no answer: the probe decides then. The list
 * is the one that CLI started with, so a sign-in since it launched shows up
 * once it is released or a probe reads again.
 */
function liveModels(): Promise<SdkModelInfo[] | undefined> {
  return readFromLiveClaude((control) =>
    liveInitializationResult(control)?.then((result) =>
      Array.isArray(result?.models) && result.models.length > 0
        ? (result.models as SdkModelInfo[])
        : undefined,
    ),
  );
}

/**
 * Get available models from the Claude Agent SDK: from a CLI already running
 * on this bridge when there is one, else through a control-only query (see
 * control-only-query.ts), which spawns a CLI for the answer.
 */
export async function getAvailableModelCatalog(): Promise<{
  models: ModelInfo[];
  source: "sdk" | "fallback";
}> {
  const live = await liveModels();
  if (live) {
    debugLog("[session-manager] Supported models read from a running CLI", {
      count: live.length,
    });
    return { source: "sdk", models: catalogModels(live) };
  }
  let q: ReturnType<typeof controlOnlyQuery> | undefined;
  try {
    const cwd = process.env.CWD || process.cwd();
    debugLog("[session-manager] Fetching supported models", { cwd });
    // A control-only query: supportedModels() without running a turn.
    q = controlOnlyQuery({
      cwd,
      env: { ...process.env },
      ...claudeExecutableOptions(),
    });

    // Get supported models from the query object
    const models = await q.supportedModels();
    debugLog("[session-manager] Supported models fetched", { count: models.length });

    return { source: "sdk", models: catalogModels(models) };
  } catch (error) {
    console.error("[session-manager] Error fetching supported models:", error);
    // Return the shared fallback if SDK discovery fails. The renderer projects
    // the same protocol constant into its local ClaudeModel shape.
    return {
      source: "fallback",
      models: CLAUDE_FALLBACK_MODEL_CATALOG.map((model) => ({
        ...model,
        ...(model.supportedEffortLevels
          ? { supportedEffortLevels: [...model.supportedEffortLevels] }
          : {}),
      })),
    };
  } finally {
    if (q?.return) {
      try {
        await q.return();
      } catch (error) {
        debugLog("[session-manager] Failed to clean up model query:", error);
      }
    }
  }
}

export async function getAvailableModels(): Promise<ModelInfo[]> {
  return (await getAvailableModelCatalog()).models;
}

export async function getClaudeRuntimeVersions(): Promise<{
  sdkVersion?: string;
  cliVersion?: string;
}> {
  let sdkVersion: string | undefined;
  let bundledCliVersion: string | undefined;
  try {
    const sdkEntryUrl = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    const manifest = JSON.parse(await readFile(new URL("./package.json", sdkEntryUrl), "utf8")) as {
      version?: string;
      claudeCodeVersion?: string;
    };
    sdkVersion = manifest.version;
    bundledCliVersion = manifest.claudeCodeVersion;
  } catch (error) {
    debugLog("[session-manager] Failed to read Claude SDK version:", error);
  }

  const executable = process.env.CLAUDE_CLI_PATH?.trim();
  if (!executable) {
    return { sdkVersion, cliVersion: bundledCliVersion };
  }

  try {
    const output = await execFileText(executable, ["--version"], 5_000);
    return {
      sdkVersion,
      cliVersion: output.match(/\d+\.\d+\.\d+/)?.[0] ?? bundledCliVersion,
    };
  } catch (error) {
    debugLog("[session-manager] Failed to read Claude CLI version:", error);
    return { sdkVersion, cliVersion: bundledCliVersion };
  }
}
