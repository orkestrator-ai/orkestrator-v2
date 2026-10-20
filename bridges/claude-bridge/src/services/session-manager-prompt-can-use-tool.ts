import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { InteractionDeadline } from "@orkestrator/protocol/agent-interaction-deadline";
import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import type { PlanApprovalRequest, QuestionInfo, QuestionRequest } from "../types/index.js";
import {
  claudeAsksForApproval,
  claudePermissionMode,
  claudeTurnPolicy,
} from "./claude-query-config.js";
import { recordClaudeToolAwaitingApproval } from "./change-evidence.js";
import { eventEmitter } from "./event-emitter.js";
import { debugLog } from "./logger.js";
import {
  PLAN_APPROVAL_TIMEOUT_MS,
  QUESTION_TIMEOUT_MS,
  type PlanApprovalResponse,
  applySessionPlanMode,
  generateMessageId,
  pendingPlanApprovals,
  pendingQuestions,
  planApprovalResolvers,
  questionResolvers,
} from "./session-manager-core.js";
import { canAdmitInteraction } from "./session-manager-interaction-budget.js";
import {
  interactionExpiryMessage,
  registerInteractionDeadline,
} from "./session-manager-interaction-holds.js";
import {
  claudeArtifactServerTools,
  claudeWorkflowResultTools,
} from "./claude-workflow-result-tools.js";
import { abortSession } from "./session-manager-lifecycle.js";
import { requestClaudeToolApproval } from "./session-manager-parked-interactions.js";
import type { TurnState } from "./session-manager-prompt-turn.js";

function boundedPlan(content: unknown): Pick<PlanApprovalRequest, "plan" | "planTruncated"> {
  if (typeof content !== "string" || content.trim().length === 0) return {};
  const maximumLength = AGENT_INTERACTION_LIMITS.maxTextLength;
  if (content.length <= maximumLength) return { plan: content };
  return {
    plan: `${content.slice(0, Math.max(0, maximumLength - 1))}…`,
    planTruncated: true,
  };
}

export async function turnCanUseTool(
  turn: TurnState,
  toolName: string,
  input: Record<string, unknown>,
  permissionContext: Parameters<CanUseTool>[2],
): ReturnType<CanUseTool> {
  const { session, sessionId, stream } = turn;
  if (toolName === "AskUserQuestion") {
    const questions: QuestionInfo[] = Array.isArray(input.questions) ? input.questions : [];
    const questionTexts = questions.map((question) => question.question);
    if (new Set(questionTexts).size !== questionTexts.length) {
      // The Agent SDK answer contract is Record<questionText, string>.
      // Duplicate text cannot be represented without silently
      // overwriting one answer, so fail closed and let Claude ask again
      // with distinct wording.
      return {
        behavior: "deny" as const,
        message:
          "AskUserQuestion contains duplicate question text. Ask the questions again with distinct wording.",
      };
    }
    // Create a question request and wait for user answer
    // The SDK request id survives transport reinitialization. Reusing it
    // keeps a redelivered question attached to the same UI interaction.
    const questionId = permissionContext?.requestId || generateMessageId();
    const requestedAt = Date.now();
    const questionRequest: QuestionRequest = {
      id: questionId,
      sessionId,
      questions,
      toolUseId: permissionContext?.toolUseID ?? questionId,
      requestedAt,
      expiresAt: requestedAt + QUESTION_TIMEOUT_MS,
    };

    if (!canAdmitInteraction(questionRequest, "questions")) {
      return {
        behavior: "deny",
        message: "Too many pending interactions. Answer an existing request first.",
      };
    }
    // The deadline the user may pause. Registered before the question is
    // announced, so the first read already carries its hold state.
    let rejectOnExpiry!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectOnExpiry = reject;
    });
    const deadline: InteractionDeadline = new InteractionDeadline({
      requestedAt,
      windowMs: QUESTION_TIMEOUT_MS,
      onExpire: () => rejectOnExpiry(new Error(interactionExpiryMessage("Question", deadline))),
    });
    const releaseDeadline = registerInteractionDeadline("questions", questionRequest, deadline);

    // Store the question
    pendingQuestions.set(questionId, questionRequest);

    // Emit event so frontend knows to show the question
    eventEmitter.emit({
      type: "question.asked",
      sessionId,
      data: questionRequest,
    });

    // Wait for answer with a Promise that can be resolved externally
    const answerPromise = new Promise<Record<string, string>>((resolve, reject) => {
      questionResolvers.set(questionId, { resolve, reject });
    });

    try {
      const answers = await Promise.race([answerPromise, timeoutPromise]);
      console.log("[session-manager] Received question answers", {
        questionId,
        answerCount: Object.keys(answers).length,
      });

      // Return the answers to the SDK
      return {
        behavior: "allow" as const,
        updatedInput: {
          questions: input.questions,
          answers,
        },
      };
    } catch (error) {
      console.error("[session-manager] Error waiting for answer:", error);
      const message = error instanceof Error ? error.message : "Question was cancelled";
      if (pendingQuestions.has(questionId)) {
        eventEmitter.emit({
          type: "question.answered",
          sessionId,
          data: { requestId: questionId, cancelled: true },
        });
      }
      return { behavior: "deny" as const, message };
    } finally {
      // Cleanup
      releaseDeadline();
      pendingQuestions.delete(questionId);
      questionResolvers.delete(questionId);
    }
  }

  // Handle EnterPlanMode - emit event so frontend can update plan mode state
  if (toolName === "EnterPlanMode") {
    debugLog("[session-manager] EnterPlanMode requested", { sessionId });

    // The agent itself switched the session into plan mode; record it
    // like a user toggle so the preference survives a restart.
    try {
      await applySessionPlanMode(session, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to persist plan mode";
      return {
        behavior: "deny" as const,
        message: `Plan mode could not be persisted safely: ${message}`,
      };
    }

    // Emit event so frontend knows to enter plan mode
    eventEmitter.emit({
      type: "plan.enter-requested",
      sessionId,
      data: { sessionId },
    });

    // Allow the tool to proceed
    return {
      behavior: "allow" as const,
      updatedInput: input,
    };
  }

  // Handle ExitPlanMode - wait for user approval before allowing
  if (toolName === "ExitPlanMode") {
    debugLog("[session-manager] ExitPlanMode requested, waiting for user approval", {
      sessionId,
    });

    // Create a plan approval request and wait for user decision
    // Keep the provider's stable identity so a transport replay cannot
    // manufacture a second approval card for the same request.
    const approvalId = permissionContext?.requestId || generateMessageId();
    // The SDK's ExitPlanMode request is the authoritative plan. Reading
    // and replaying the preceding plan-file edits duplicated Edit
    // semantics and could drift from the bytes Claude actually asks
    // the user to approve.
    const directPlan = boundedPlan(input?.plan);
    const requestedAt = Date.now();
    const approvalRequest: PlanApprovalRequest = {
      id: approvalId,
      sessionId,
      toolUseId: permissionContext?.toolUseID ?? approvalId,
      ...directPlan,
      requestedAt,
      expiresAt: requestedAt + PLAN_APPROVAL_TIMEOUT_MS,
    };

    if (!canAdmitInteraction(approvalRequest, "approvals")) {
      return {
        behavior: "deny",
        message: "Too many pending interactions. Answer an existing request first.",
      };
    }
    let rejectOnExpiry!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectOnExpiry = reject;
    });
    const deadline: InteractionDeadline = new InteractionDeadline({
      requestedAt,
      windowMs: PLAN_APPROVAL_TIMEOUT_MS,
      onExpire: () =>
        rejectOnExpiry(new Error(interactionExpiryMessage("Plan approval", deadline))),
    });
    const releaseDeadline = registerInteractionDeadline(
      "plan-approvals",
      approvalRequest,
      deadline,
    );

    // Store the approval request and set up the resolver BEFORE emitting,
    // so an instant response from the UI can never find a missing resolver.
    pendingPlanApprovals.set(approvalId, approvalRequest);

    const approvalPromise = new Promise<PlanApprovalResponse>((resolve, reject) => {
      planApprovalResolvers.set(approvalId, { resolve, reject });
    });

    // Emit event so frontend knows to show the approval UI
    eventEmitter.emit({
      type: "plan.approval-requested",
      sessionId,
      data: approvalRequest,
    });

    try {
      const response = await Promise.race([approvalPromise, timeoutPromise]);
      console.log("[session-manager] Plan approval result", {
        approvalId,
        approved: response.approved,
        hasFeedback: typeof response.feedback === "string" && response.feedback.length > 0,
      });

      if (response.approved) {
        // User approved - emit exit event and allow the tool.
        // Mark `stream.planApprovedThisTurn` so the fallback below can detect
        // the case where the SDK still fails the ExitPlanMode tool
        // (override the failure + re-prompt Claude to continue).
        // Approval ends plan mode; record it so the preference the
        // next prompt rehydrates from matches what the UI shows.
        try {
          const control = session.queryControl;
          if (!control?.setPermissionMode)
            throw new Error("Claude permission control is unavailable");
          await control.setPermissionMode(
            claudePermissionMode(
              claudeTurnPolicy(session.executionPolicy, turn.options?.readOnly),
              turn.options?.approvalMode,
            ),
          );
          await applySessionPlanMode(session, false);
        } catch (error) {
          // A rejected control request may already have reached the CLI. Restore
          // plan mode, or stop the runtime if that boundary cannot be confirmed.
          try {
            const control = session.queryControl;
            if (!control?.setPermissionMode)
              throw new Error("Claude permission control is unavailable");
            await control.setPermissionMode("plan");
          } catch {
            abortSession(sessionId);
          }
          const message = error instanceof Error ? error.message : "Failed to persist plan mode";
          return {
            behavior: "deny" as const,
            message: `Plan mode could not be exited safely: ${message}`,
          };
        }
        stream.planApprovedThisTurn = true;
        eventEmitter.emit({
          type: "plan.exit-requested",
          sessionId,
          data: { sessionId },
        });

        return {
          behavior: "allow" as const,
          updatedInput: input,
        };
      } else {
        // User rejected - deny the tool and include feedback if provided.
        // Also capture the feedback so we can re-prompt Claude if the SDK
        // ends the turn after the denial (ExitPlanMode denial may terminate
        // the agent loop without Claude generating a revision).
        const feedbackMessage = response.feedback
          ? `User feedback: "${response.feedback}"`
          : "No specific feedback was provided.";
        const denyMessage = `User rejected the plan. ${feedbackMessage} Please revise your approach based on this feedback.`;

        // Store the raw feedback for potential re-prompt
        stream.pendingPlanRejectionFeedback = response.feedback
          ? `I've reviewed the plan and I'd like changes: ${response.feedback}\n\nPlease revise the plan based on this feedback.`
          : `I've reviewed the plan and I don't approve it as-is. Please revise your approach.`;

        return {
          behavior: "deny" as const,
          message: denyMessage,
        };
      }
    } catch (error) {
      console.error("[session-manager] Error waiting for plan approval:", error);
      const errorMessage = error instanceof Error ? error.message : "Plan approval was cancelled";
      if (pendingPlanApprovals.has(approvalId)) {
        eventEmitter.emit({
          type: "plan.approval-responded",
          sessionId,
          data: {
            requestId: approvalId,
            approved: false,
            cancelled: true,
          },
        });
      }
      // If error (e.g., timeout or dismissed), deny the tool use
      return { behavior: "deny" as const, message: errorMessage };
    } finally {
      // Cleanup
      releaseDeadline();
      pendingPlanApprovals.delete(approvalId);
      planApprovalResolvers.delete(approvalId);
    }
  }

  // An `ask` policy or an asking approval mode means the user decides, and a
  // `deny` policy refuses anything outside its allow list. Questions and plan
  // approvals are handled above, so a denying session can still ask the user.
  // Otherwise the mode already chose not to ask, so a tool that still reaches
  // here runs.
  if (
    (claudeWorkflowResultTools(turn.mcpServerNames).includes(toolName) ||
      claudeArtifactServerTools(turn.mcpServerNames).includes(toolName)) &&
    !session.executionPolicy?.toolPolicy?.deny?.includes(toolName)
  ) {
    return { behavior: "allow", updatedInput: input };
  }
  const turnPolicy = claudeTurnPolicy(session.executionPolicy, turn.options?.readOnly);
  const approvals = turnPolicy?.approvals;
  if (claudeAsksForApproval(turnPolicy, turn.options)) {
    recordClaudeToolAwaitingApproval(sessionId, permissionContext?.toolUseID, toolName, input);
    return requestClaudeToolApproval(sessionId, toolName, input, permissionContext);
  }
  if (approvals === "deny") {
    return {
      behavior: "deny" as const,
      message: `${toolName} is not allowed: this session's policy denies approvals.`,
    };
  }

  // Allow this invocation only. SDK permission suggestions are durable
  // policy updates and belong behind an explicit "always allow" choice;
  // this host does not currently present one, so returning suggestions
  // here would silently widen permissions after an allow-once decision.
  return {
    behavior: "allow" as const,
    updatedInput: input,
  };
}
