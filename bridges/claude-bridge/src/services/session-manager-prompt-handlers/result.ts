import { classifyUsageLimitError } from "@orkestrator/protocol/agent-usage-limits";
import type { SDKMessage, SDKStartupFailureReason } from "@anthropic-ai/claude-agent-sdk";
import { structuredOutputFailure } from "@orkestrator/protocol/structured-output";
import type { SdkResultMessage } from "../../types/index.js";
import { eventEmitter } from "../event-emitter.js";
import { debugLog } from "../logger.js";
import { appendLocalCommandResult } from "../session-manager-commands.js";
import {
  ClaudeStructuredOutputError,
  buildClaudeUsageSnapshot,
  recordStructuredOutput,
} from "../session-manager-core.js";
import {
  resultAnswersOtherInput,
  resultInputUuids,
  resultSupersededBySteer,
} from "../session-manager-messages.js";
import {
  finishTurnInputIfSettled,
  ownsActiveTurn,
  recordInterruptedStructuredOutputIfCurrent,
  settleResultWithoutOwnership,
} from "../session-manager-prompt-turn-lifecycle.js";
import type { TurnState } from "../session-manager-prompt-turn.js";
import { reconcileClaudeUsage } from "../session-manager-usage.js";
import { markTranscriptChanged } from "../transcript-revision.js";
import { appendTranscriptNotice } from "./transcript-notice.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.claude");

export function claudeStartupFailureMessage(reason: SDKStartupFailureReason): string {
  switch (reason) {
    case "org_pin_api_key_conflict":
      return "Claude is configured for a managed organization, but an API key or auth token is overriding that sign-in. Remove the conflicting credential and sign in again.";
    case "org_verify_failed":
      return "Claude could not verify the signed-in organization. Check connectivity, then sign in again if the token was revoked.";
    case "org_pin_mismatch":
      return "The Claude account does not belong to the organization required by managed settings. Sign in with an allowed organization.";
    case "managed_settings_invalid":
      return "Claude could not read the managed settings policy. Ask an administrator to validate the organization policy.";
    case "remote_settings_required_unavailable":
      return "Required Claude managed settings are unavailable. Restore connectivity to the managed-settings service and retry.";
    case "gateway_signin_required":
      return "The Claude gateway requires a fresh sign-in. Sign in to Claude again, then retry.";
    case "gateway_access_denied":
      return "The Claude gateway denied access to this account's managed settings. Ask an administrator to verify access.";
    case "proxy_invalid":
      return "Claude's proxy setting is not a valid complete URL. Correct the proxy configuration and retry.";
    case "temp_dir_unusable":
      return "Claude cannot safely use the current temporary directory. Check its ownership and permissions, then retry.";
    case "cwd_unavailable":
      return "The workspace directory is missing or unreadable. Restore access to it, then retry.";
    case "shell_tool_missing":
      return "Claude cannot find a supported shell. Install or enable Git Bash or PowerShell, then retry.";
    case "session_held_by_background":
      return "This Claude conversation is still running in a background session. Stop or reconnect to that session before resuming it here.";
    case "worktree_resume_refused":
      return "Claude refused to resume because the session worktree did not pass its safety checks. Review the provider error and reopen the workspace safely.";
    case "worktree_unverified":
      return "Claude could not verify the session worktree. Retry after the worktree becomes available.";
    case "cli_version_too_old":
      return "This Claude Code version is below the provider's minimum. Update Claude Code and retry.";
    case "bypass_root":
      return "Claude cannot use bypass-permissions mode while running as root. Run the agent as a non-root user.";
    case "provider_not_allowed":
      return "Managed settings do not allow the API provider this session is configured for. Ask an administrator to allow it, or switch provider.";
    case "org_config_required_unavailable":
      return "Claude could not load the policy limits and managed settings your organization requires. Check connectivity and any proxy, then retry.";
    case "org_config_refused":
      return "Anthropic refused your organization's required Claude settings for this sign-in. Sign in to Claude again; if that does not help, ask an administrator to allow Claude Code for this account.";
    case "sandbox_required_unavailable":
      return "Claude requires a working command sandbox, and it cannot run here (for example, bubblewrap is missing or the platform is unsupported). Make the sandbox available or have the requirement changed, then retry.";
  }
}

const MAX_USAGE_LIMIT_ERROR_CHARS = 500;

/** How the CLI ends a turn that a graceful interrupt stopped. */
const STOPPED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "aborted_streaming",
  "aborted_tools",
]);

/** `result`: the end of a model turn, or of a continuation the turn was retained for. */
export async function handleResultMessage(turn: TurnState, message: SDKMessage): Promise<void> {
  const { session, sessionId, stream } = turn;
  // Only allowlisted metadata reaches the shared debug sink.
  const resultMsg = message as SdkResultMessage;
  // A resumed CLI can finish a turn of its own (a replayed task
  // notification) before it reaches this prompt. That result says
  // nothing about this turn; ending on it closed the CLI's input, which
  // later stopped its background agents. Only this turn's first result
  // is filtered: once it has arrived, a continuation's result is the
  // legitimate end of the retained turn.
  if (
    !turn.receivedPromptResult &&
    resultAnswersOtherInput(resultMsg, turn.promptUuid, turn.steerUuids)
  ) {
    // Whatever the CLI ran first, it was not this prompt: an inherited
    // continuation has now been answered.
    turn.inheritedContinuation = false;
    debugLog("[session-manager] Result for other input skipped", {
      sessionId,
      subtype: resultMsg.subtype,
      durationMs: resultMsg.duration_ms,
    });
    return;
  }
  // The only authoritative link between the id this bridge minted for the
  // prompt and the transcript record it became. Everything destructive
  // (fork boundary, file rewind) resolves through it, so it is recorded
  // and republished rather than inferred from message ordering. A steer's
  // result names the steer, whose record is not this prompt's.
  const recordPromptSdkUuid = () => {
    const uuids = resultInputUuids(resultMsg);
    const sdkUuid = uuids.includes(turn.promptUuid)
      ? turn.promptUuid
      : turn.userMessage.sdkUuid
        ? undefined
        : uuids.find((uuid) => !turn.steerUuids.has(uuid));
    if (sdkUuid && turn.userMessage.sdkUuid !== sdkUuid) {
      turn.userMessage.sdkUuid = sdkUuid;
      markTranscriptChanged(session);
      eventEmitter.emit({
        type: "message.updated",
        sessionId,
        data: { message: turn.userMessage },
      });
    }
  };
  if (resultSupersededBySteer(resultMsg, turn.unansweredSteerUuids, turn.latestSteerUuid)) {
    // The prompt was answered, if only by the interruption, so what
    // follows is no longer filtered as another input's result.
    if (resultInputUuids(resultMsg).includes(turn.promptUuid)) turn.receivedPromptResult = true;
    recordPromptSdkUuid();
    debugLog("[session-manager] Result superseded by steer skipped", {
      sessionId,
      subtype: resultMsg.subtype,
      durationMs: resultMsg.duration_ms,
    });
    return;
  }
  // A result that also names input other than this turn's own answered
  // the inherited continuation together with this prompt.
  if (
    turn.inheritedContinuation &&
    resultInputUuids(resultMsg).some(
      (uuid) => uuid !== turn.promptUuid && !turn.steerUuids.has(uuid),
    )
  ) {
    turn.inheritedContinuation = false;
  }
  turn.diagnostics?.terminalSettled("resolved");
  turn.receivedResult = true;
  turn.receivedPromptResult = true;
  const interruptRequested = session.interruptRequestedGeneration === turn.turnGeneration;
  // Consume only this generation's request on every terminal result, including
  // normal completion after partial output and structured-output failures.
  if (interruptRequested) session.interruptRequestedGeneration = undefined;
  debugLog("[session-manager] Query result", {
    sessionId,
    subtype: resultMsg.subtype,
    costUSD: resultMsg.total_cost_usd,
    durationMs: resultMsg.duration_ms,
  });
  recordPromptSdkUuid();

  // Account allocation can advance during the last model request. Queue
  // one final coalesced refresh before publishing the completed token
  // snapshot, preserving the previous end-of-turn exactness.
  if (!ownsActiveTurn(turn)) {
    if (!turn.abortController.signal.aborted) {
      settleResultWithoutOwnership(turn);
      return;
    }
    // Stopping the latest turn already stopped its process.
    recordInterruptedStructuredOutputIfCurrent(turn);
    return;
  }
  // Both round trips can take seconds. Lifecycle hooks and task stops
  // keep arriving meanwhile; they record task state, and the settle they
  // would trigger waits for `finishTurnInputIfSettled` below.
  turn.settlingResult = true;
  let exactUsage: Awaited<ReturnType<typeof buildClaudeUsageSnapshot>>;
  try {
    await turn.structuredUsageRefresh?.trigger();
    exactUsage = await buildClaudeUsageSnapshot(
      session,
      resultMsg,
      turn.queryIteratorControl,
      turn.options?.model,
      {
        ...(turn.bootstrapClaudeUsage
          ? { bootstrapTurnTokens: turn.streamUsage.completedTotals() }
          : {}),
        stillOwnsTurn: () => ownsActiveTurn(turn),
      },
    );
  } finally {
    turn.settlingResult = false;
  }
  if (!ownsActiveTurn(turn)) {
    if (!turn.abortController.signal.aborted) {
      settleResultWithoutOwnership(turn);
      return;
    }
    // The provider accepted this request, so the caller needs a
    // terminal outcome even though abort won the race with the final
    // usage snapshot. A newer structured turn replaces the request id
    // before taking ownership; never let this old turn overwrite it.
    recordInterruptedStructuredOutputIfCurrent(turn);
    return;
  }
  turn.bootstrapClaudeUsage = false;
  const streamedUsage =
    session.inProgressUsageGeneration === turn.turnGeneration ? session.inProgressUsage : undefined;
  const settledUsage = reconcileClaudeUsage(exactUsage, streamedUsage);
  // A provider/runtime pair may omit terminal totals even though its
  // message stream reported completed calls. Conversely, a completely
  // silent turn must retain the prior durable snapshot.
  if (settledUsage) session.usage = settledUsage;
  if (session.inProgressUsageGeneration === turn.turnGeneration) {
    session.inProgressUsage = undefined;
    session.inProgressUsageGeneration = undefined;
  }
  turn.streamUsage.reset();
  if (session.usage || session.rateLimits !== undefined) {
    eventEmitter.emit({
      type: "session.updated",
      sessionId,
      data: {
        ...(session.usage ? { contextUsage: session.usage } : {}),
        ...(session.rateLimits !== undefined ? { rateLimits: session.rateLimits } : {}),
      },
    });
  }

  // `is_error` is authoritative over `subtype`. The SDK documents
  // `subtype: "success"` with `is_error: true` as "the turn ended on an
  // API error", so reading the subtype alone reported a failed turn as a
  // completed one and left the error text in `errors` unpublished.
  const resultIsError = resultMsg.is_error === true;
  if (resultMsg.subtype === "success" && !resultIsError) {
    if (turn.options?.outputSchema) {
      if (resultMsg.structured_output === undefined) {
        const failure = structuredOutputFailure(
          "claude",
          "malformed_output",
          "Claude completed the turn without a structured result.",
          { requestId: turn.structuredRequestId },
        );
        recordStructuredOutput(session, failure);
        throw new ClaudeStructuredOutputError(failure);
      }
      recordStructuredOutput(session, {
        ok: true,
        provider: "claude",
        requestId: turn.structuredRequestId,
        value: resultMsg.structured_output,
      });
    }
    // A local command (`/cost`, `/context`, ...) can finish with its
    // answer only in `result` — no assistant message, no output frame.
    // Surface that text so the turn does not settle invisibly. Taken
    // from the SDK's own result, never synthesized from the command.
    if (
      !turn.options?.outputSchema &&
      !turn.localCommandOutputSeen &&
      !stream.assistantOutputSeen &&
      typeof resultMsg.result === "string" &&
      resultMsg.result.trim()
    ) {
      appendLocalCommandResult(
        session,
        resultMsg.result,
        `result:${typeof resultMsg.uuid === "string" ? resultMsg.uuid : turn.turnGeneration}`,
      );
    }
    debugLog("[session-manager] Query completed successfully", { sessionId });
    finishTurnInputIfSettled(turn);
  } else if (
    !turn.options?.outputSchema &&
    STOPPED_TERMINAL_REASONS.has(resultMsg.terminal_reason ?? "") &&
    interruptRequested
  ) {
    // The user stopped the turn before any text streamed. The CLI reports
    // that as an aborted error result, which is the stop that was asked for:
    // settle as a stop does once text has streamed, never as a failure.
    debugLog("[session-manager] Query stopped by the user", { sessionId });
    finishTurnInputIfSettled(turn);
  } else {
    log.error("query.failed", { subtype: resultMsg.subtype, sessionId, isError: resultIsError });
    const startupFailure = resultMsg.startup_failure_reason
      ? claudeStartupFailureMessage(resultMsg.startup_failure_reason)
      : undefined;
    // A refused turn's words are only in `result` ("You've hit your limit ·
    // resets 3pm"), and the turn's error is how the backend learns of the limit.
    // Other API errors keep the fixed text: `result` can hold the model's own.
    const usageLimit =
      resultMsg.subtype === "success" && classifyUsageLimitError(resultMsg.result)
        ? (resultMsg.result as string).trim().slice(0, MAX_USAGE_LIMIT_ERROR_CHARS)
        : undefined;
    const resultError =
      startupFailure ||
      resultMsg.errors?.filter(Boolean).join("\n") ||
      usageLimit ||
      (resultMsg.subtype === "success"
        ? "Claude ended the turn on an API error."
        : `Claude query failed: ${resultMsg.subtype}`);
    if (startupFailure) {
      appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
        type: "status",
        content: startupFailure,
        severity: "error",
        createdAt: new Date().toISOString(),
      });
    }
    if (turn.options?.outputSchema) {
      const failure = structuredOutputFailure(
        "claude",
        resultMsg.subtype === "error_max_structured_output_retries"
          ? "schema_retry_exhausted"
          : "provider_error",
        resultError,
        {
          requestId: turn.structuredRequestId,
          details: { subtype: resultMsg.subtype ?? "unknown" },
        },
      );
      recordStructuredOutput(session, failure);
      throw new ClaudeStructuredOutputError(failure);
    }
    throw new Error(resultError);
  }
}
