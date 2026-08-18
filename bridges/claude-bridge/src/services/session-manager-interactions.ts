// Session Manager Service
// Handles session state and interacts with Claude Agent SDK

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ImageBlockParam,
  TextBlockParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  ModelInfo,
  SessionState,
  NormalizedMessage,
  NormalizedPart,
  ToolDiffMetadata,
  QuestionInfo,
  QuestionRequest,
  PlanApprovalRequest,
  PromptOptions,
  SessionInitData,
  McpServerRuntimeStatus,
  PluginRuntimeStatus,
  SdkMessageBase,
  SdkCompactBoundaryMessage,
  SdkResultMessage,
  SdkSystemMessage,
  TaskListSnapshot,
  MessagePatchEventData,
  SessionUsageSnapshot,
  BackgroundTaskSnapshot,
  SessionRateLimitWindow,
  StopBackgroundTaskResult,
} from "../types/index.js";
import { isSdkCompactBoundaryMessage, isSdkResultMessage } from "../types/index.js";
import { TaskRegistry, isTaskListTool } from "@orkestrator/protocol/task-list";
import { AGENT_INTERACTION_DEFAULT_TIMEOUT_MS } from "@orkestrator/protocol/agent-interactions";
import { isRootAssistantRecord, normalizeBackendModelId } from "@orkestrator/protocol/model-id";
import {
  structuredOutputFailure,
  type StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { eventEmitter } from "./event-emitter.js";
import {
  deleteSessionPreferences,
  MAX_DISPATCHED_REQUEST_IDS,
  readSessionPreferences,
  sessionPreferencesUnavailable,
  updateSessionPreferences,
  type SessionPreferences,
} from "./session-preferences.js";
import { runtimeEnvironmentForAgentQuery } from "./runtime-env.js";
import { debugLog, isDebugLoggingEnabled } from "./logger.js";
import { applyDiffBudget, applyToolResultBudget } from "./part-budget.js";
import { getMcpRuntimeConfig } from "./mcp-config.js";
import { getPluginsForSdk } from "./plugin-config.js";
import type { McpToolMetadata } from "../types/mcp.js";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, type Stats } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import * as core from "./session-manager-core.js";
import * as lifecycle from "./session-manager-lifecycle.js";
import {
  claudeExecutableOptions,
  execFileText,
  pendingPlanApprovals,
  pendingQuestions,
  planApprovalResolvers,
  questionResolvers,
  sessions,
} from "./session-manager-core.js";
import { isPendingInteractionFor } from "./session-manager-lifecycle.js";
type PromptDispatchState = lifecycle.PromptDispatchState;
type PromptDispatchRecord = lifecycle.PromptDispatchRecord;
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
 * Get session initialization data (MCP servers, plugins, slash commands)
 */
export function getSessionInitData(sessionId: string): SessionInitData | undefined {
  const session = sessions.get(sessionId);
  return session?.initData;
}

/**
 * Get available models from the Claude Agent SDK
 * The supportedModels() method is available on the Query object returned by query()
 */
export async function getAvailableModelCatalog(): Promise<{
  models: ModelInfo[];
  source: "sdk" | "fallback";
}> {
  let q: ReturnType<typeof query> | undefined;
  try {
    const cwd = process.env.CWD || process.cwd();
    debugLog("[session-manager] Fetching supported models", { cwd });
    // Create a query object to access supportedModels()
    // We use maxTurns: 0 to prevent any actual processing
    q = query({
      prompt: "",
      options: {
        maxTurns: 0,
        cwd,
        ...claudeExecutableOptions(),
      },
    });

    // Get supported models from the query object
    const models = await q.supportedModels();
    debugLog("[session-manager] Supported models fetched", { count: models.length });

    return {
      source: "sdk",
      models: models.map((model) => ({
        id: model.value,
        resolvedModel: model.resolvedModel,
        name: model.displayName,
        description: model.description,
        supportsFastMode: model.supportsFastMode,
        supportsEffort: model.supportsEffort,
        supportedEffortLevels: model.supportedEffortLevels,
        supportsAdaptiveThinking: model.supportsAdaptiveThinking,
        supportsAutoMode: model.supportsAutoMode,
      })),
    };
  } catch (error) {
    console.error("[session-manager] Error fetching supported models:", error);
    // Return fallback models if SDK call fails
    return {
      source: "fallback",
      models: [
        {
          id: "default",
          resolvedModel: "claude-opus-5[1m]",
          name: "Default (recommended)",
          description: "Opus 5 with 1M context · Best for everyday, complex tasks",
          supportsFastMode: true,
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "opus[1m]",
          resolvedModel: "claude-opus-5[1m]",
          name: "Opus (1M context)",
          description: "Opus 5 with 1M context · Best for everyday, complex tasks",
          supportsFastMode: true,
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "claude-fable-5[1m]",
          resolvedModel: "claude-fable-5",
          name: "Fable",
          description: "Fable 5 · Most capable for your hardest and longest-running tasks",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "sonnet",
          resolvedModel: "claude-sonnet-5",
          name: "Sonnet",
          description: "Sonnet 5 · Efficient for routine tasks",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "haiku",
          resolvedModel: "claude-haiku-4-5-20251001",
          name: "Haiku",
          description: "Haiku 4.5 · Fastest for quick answers",
        },
      ],
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
