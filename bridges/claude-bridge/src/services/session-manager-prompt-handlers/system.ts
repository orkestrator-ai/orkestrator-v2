import type {
  SDKAPIRetryMessage,
  SDKHookResponseMessage,
  SDKInformationalMessage,
  SDKMemoryRecallMessage,
  SDKMessage,
  SDKPermissionDeniedMessage,
  SDKStatusMessage,
  SDKThinkingTokensMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BackgroundTaskSnapshot,
  NormalizedPart,
  SdkSystemMessage,
  SessionState,
} from "../../types/index.js";
import { sessionHealth, systemSubtypeDisposition } from "../../types/index.js";
import { commandChangeProbe } from "../command-changes.js";
import { eventEmitter } from "../event-emitter.js";
import { debugLog } from "../logger.js";
import {
  LIVE_BACKGROUND_TASK_STATUSES,
  boundBackgroundTaskHistory,
  closeQueryControlIfUnused,
  inheritBackgroundTaskHookRun,
  isHookRunningBackgroundTask,
  parkSettlingBackgroundTask,
  takeProvisionalBackgroundTask,
  takeSettlingBackgroundTask,
} from "../session-manager-background-tasks.js";
import { appendLocalCommandResult, recordCommandsChanged } from "../session-manager-commands.js";
import {
  boundedNoticeText,
  memoryRecallPart,
  persistedBackgroundTaskMessage,
  persistedTaskUsage,
  refreshSettledToolRows,
} from "../session-manager-messages.js";
import {
  finishTurnInputIfSettled,
  ownsActiveTurn,
  reconcilePlanModeFromStatus,
  setTurnActivity,
  waitForContinuationAfterNotification,
} from "../session-manager-prompt-turn-lifecycle.js";
import type { TurnState } from "../session-manager-prompt-turn.js";
import { markTranscriptChanged } from "../transcript-revision.js";
import { appendTranscriptNotice, settlePendingApiRetry } from "./transcript-notice.js";

/**
 * How loudly to report one Claude system subtype.
 *
 * These are the SDK's own diagnostics, so they are recorded as `provider`
 * notices. The severity split is what decides whether the tab shows the notice
 * at all: `info` and `warning` stay in the health panel, while the backend
 * raises `error` in the tab as a persistent toast. Dedicated transcript rows,
 * such as API retry progress, remain independent of this health severity.
 */
const SYSTEM_MESSAGE_SEVERITIES: Record<string, "info" | "warning" | "error"> = {
  informational: "info",
  notification: "info",
  // Hook progress never reaches here (`ignored` in the disposition table). A
  // hook *response* only does when it failed, and is graded by its outcome
  // below, because a failed hook is the case this bridge cannot otherwise
  // notice.
  api_retry: "warning",
  model_refusal_fallback: "warning",
  model_refusal_no_fallback: "error",
  mirror_error: "error",
};

/**
 * Record a system subtype the dispatch above had no branch for.
 *
 * Only the subtype name and, where the SDK supplies a plain string, a bounded
 * message travel: the rest of an SDK system message can carry prompts, file
 * contents and tool output, and a notice reaches the renderer and the logs.
 */
function recordSystemMessageNotice(session: SessionState, message: SdkSystemMessage): void {
  const subtype = message.subtype ?? "unknown";
  if (subtype === "plugin_install") {
    // A failed install names its plugin and carries its own `error`, not the
    // `message` every other subtype uses; reading it generically recorded an
    // info notice with no detail.
    const install = message as { status?: unknown; name?: unknown; error?: unknown };
    if (install.status === "failed") {
      const name = typeof install.name === "string" && install.name ? install.name : undefined;
      sessionHealth(session).recordNotice({
        message: name
          ? `Claude plugin ${name} failed to install`
          : "A Claude plugin failed to install",
        method: "plugin/install",
        severity: "error",
        source: "provider",
        ...(typeof install.error === "string" && install.error ? { detail: install.error } : {}),
      });
      return;
    }
  }
  const outcome = (message as { outcome?: unknown }).outcome;
  const severity =
    subtype === "hook_response"
      ? // The hook this bridge registers observes plan writes. If it fails,
        // plan observation is broken and nothing else would report it.
        outcome === "error"
        ? "error"
        : "info"
      : (SYSTEM_MESSAGE_SEVERITIES[subtype] ?? "info");
  const detail = (message as { message?: unknown }).message;
  sessionHealth(session).recordNotice({
    message: `Claude reported ${subtype.replaceAll("_", " ")}`,
    method: `system/${subtype}`,
    severity,
    source: "provider",
    ...(typeof detail === "string" && detail.length > 0 ? { detail } : {}),
  });
}

/**
 * Minimum spacing between published thinking-token estimates.
 *
 * The SDK sends one frame per thinking delta — thousands in a long turn — and
 * every `session.updated` reaches each subscriber. A counter that ticks a few
 * times a second reads as live; one frame per delta is only load.
 */
export const THINKING_TOKENS_EMIT_INTERVAL_MS = 500;

/** `system`, other than `init`: tasks, status, notices and the subtypes the disposition table keeps. */
export async function handleSystemMessage(turn: TurnState, message: SDKMessage): Promise<void> {
  const { session, sessionId, stream } = turn;
  const { toolTracker } = stream;
  // Handle other system messages (log for debugging)
  const sysMsg = message as SdkSystemMessage;
  debugLog("[session-manager] System message received", {
    sessionId,
    subtype: sysMsg.subtype,
  });

  const taskMessage = message as {
    subtype?: string;
    task_id?: string;
    tool_use_id?: string;
    description?: string;
    summary?: string;
    /** Only on `task_notification`; the terminal edge of a task. */
    status?: "completed" | "failed" | "stopped";
    /** Only on `task_notification`; where the CLI wrote the full output. */
    output_file?: unknown;
    /** On `task_progress` and `task_notification`. */
    usage?: unknown;
    /** Only on `background_tasks_changed`; the full live set. */
    tasks?: Array<{
      task_id?: string;
      task_type?: string;
      description?: string;
      /** Agent SDK 0.3.296+: agent type, or `main-session`. */
      subagent_type?: unknown;
    }>;
    patch?: {
      status?: BackgroundTaskSnapshot["status"];
      description?: string;
      end_time?: number;
      error?: string;
      is_backgrounded?: boolean;
    };
  };

  const emitBackgroundTasks = () => {
    eventEmitter.emit({
      type: "session.updated",
      sessionId,
      data: { backgroundTasks: session.backgroundTasks },
    });
  };

  if (sysMsg.subtype === "commands_changed") {
    // A full replacement (SDKCommandsChangedMessage). Applied to the
    // bridge-owned inventory whether or not anybody is subscribed.
    recordCommandsChanged(session, message);
  } else if (sysMsg.subtype === "local_command_output") {
    // A command the CLI answered itself (SDKLocalCommandOutputMessage).
    // Without this row the turn settles with nothing visible.
    const output = (message as { content?: unknown }).content;
    if (typeof output === "string") {
      turn.localCommandOutputSeen = true;
      appendLocalCommandResult(
        session,
        output,
        typeof sysMsg.uuid === "string"
          ? sysMsg.uuid
          : `${turn.turnGeneration}:${turn.sdkMessageCount}`,
      );
    }
  } else if (
    (taskMessage.subtype === "task_started" ||
      taskMessage.subtype === "task_progress" ||
      taskMessage.subtype === "task_updated") &&
    taskMessage.task_id
  ) {
    if (
      isHookRunningBackgroundTask(session.backgroundTasks?.[taskMessage.task_id]) &&
      taskMessage.patch?.status &&
      !LIVE_BACKGROUND_TASK_STATUSES.has(taskMessage.patch.status)
    )
      return;
    const correlated = takeProvisionalBackgroundTask(session, taskMessage.tool_use_id);
    const stored = session.backgroundTasks?.[taskMessage.task_id] ?? correlated.task;
    // A `SendMessage` resume re-runs a finished agent under its old task
    // id, announced by a `task_started` from the resuming call. That is a
    // new run, not a late edge of the old one: left terminal, nothing
    // held this query's input open for it, and the CLI stopped the agent
    // once its idle wind-down ran out.
    const resumedRun =
      taskMessage.subtype === "task_started" &&
      stored !== undefined &&
      !LIVE_BACKGROUND_TASK_STATUSES.has(stored.status) &&
      typeof taskMessage.tool_use_id === "string" &&
      taskMessage.tool_use_id !== stored.toolUseId;
    if (resumedRun) {
      // The finished run's parked snapshot must not describe this one.
      const parked = takeSettlingBackgroundTask(session, taskMessage.task_id);
      if (parked) closeQueryControlIfUnused(session, parked.owner);
    }
    const previous = resumedRun
      ? {
          ...stored,
          status: "running" as const,
          startedAt: Date.now(),
          endedAt: undefined,
          error: undefined,
          summary: undefined,
          outputFile: undefined,
          usage: undefined,
        }
      : stored;
    const patchedStatus = taskMessage.patch?.status ?? previous?.status ?? "running";
    // Within one run, level and edge messages may be delivered in either
    // order, so a late start/progress edge must enrich a terminal record
    // rather than resurrect it.
    const status =
      previous &&
      !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status) &&
      LIVE_BACKGROUND_TASK_STATUSES.has(patchedStatus)
        ? previous.status
        : patchedStatus;
    const task: BackgroundTaskSnapshot = {
      id: taskMessage.task_id,
      toolUseId: taskMessage.tool_use_id ?? previous?.toolUseId,
      description:
        taskMessage.patch?.description ?? taskMessage.description ?? previous?.description,
      status,
      isBackgrounded: taskMessage.patch?.is_backgrounded ?? previous?.isBackgrounded,
      startedAt: previous?.startedAt ?? Date.now(),
      endedAt: taskMessage.patch?.end_time ?? previous?.endedAt,
      error: taskMessage.patch?.error ?? previous?.error,
      summary: previous?.summary,
      outputFile: previous?.outputFile,
      subagentType: previous?.subagentType,
      // Terminal usage wins over an older progress frame delivered late.
      usage:
        previous && !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status) && previous.usage
          ? previous.usage
          : (persistedTaskUsage(taskMessage.usage) ?? previous?.usage),
    };
    inheritBackgroundTaskHookRun(previous, task);
    session.backgroundTasks = boundBackgroundTaskHistory({
      ...session.backgroundTasks,
      [task.id]: task,
    });
    if (LIVE_BACKGROUND_TASK_STATUSES.has(task.status)) {
      (session.backgroundTaskControls ??= new Map()).set(task.id, turn.queryIteratorControl!);
    } else {
      const owner = session.backgroundTaskControls?.get(task.id) ?? correlated.owner;
      session.backgroundTaskControls?.delete(task.id);
      // A finishing task sends its terminal patch before the
      // `task_notification` edge, while the CLI is still queueing the
      // notification it will answer. For a released turn this is the
      // same boundary as that edge: closing here kills the CLI between
      // writing the notification and running the model on it, so the
      // reply the model promised never comes.
      if (
        owner === turn.queryIteratorControl &&
        turn.turnReleasedToBackgroundTasks &&
        previous !== undefined &&
        LIVE_BACKGROUND_TASK_STATUSES.has(previous.status)
      ) {
        turn.receivedResult = false;
        waitForContinuationAfterNotification(turn);
      }
      closeQueryControlIfUnused(session, owner);
    }
    closeQueryControlIfUnused(session, correlated.owner);
    emitBackgroundTasks();
  } else if (taskMessage.subtype === "task_notification" && taskMessage.task_id) {
    const notification = persistedBackgroundTaskMessage({ message: taskMessage });
    // Invalid terminal statuses are not completion evidence, live or on replay.
    if (!notification) return;
    // A same-id wake can happen while usage settlement holds the JSONL
    // consumer. This frame may belong to the preceding run; only the
    // current run's stop hook can retire its live control.
    if (isHookRunningBackgroundTask(session.backgroundTasks?.[notification.task_id])) {
      return;
    }
    // A task notification can re-enter the root agent loop after an
    // earlier result. That earlier result is only the response boundary
    // before the notification, not permission to close streaming input.
    // Wait for the resumed loop's own result; otherwise stdin EOF lands
    // between its final tool result and final assistant message and the
    // rollout records `[Request interrupted by user]`.
    turn.receivedResult = false;
    // The terminal edge. Without it nothing ever leaves `running`, so
    // `GET /session/:id` reported a finished task as live indefinitely.
    const correlated = takeProvisionalBackgroundTask(session, notification.tool_use_id);
    // A level signal that preceded this edge has already removed the task
    // from the live set; its parked snapshot is the only remaining source
    // of the original description and start time.
    const parked = takeSettlingBackgroundTask(session, notification.task_id);
    const previous =
      session.backgroundTasks?.[notification.task_id] ?? parked?.task ?? correlated.task;
    const terminalStatus: BackgroundTaskSnapshot["status"] =
      notification.status === "failed"
        ? "failed"
        : notification.status === "stopped"
          ? "killed"
          : "completed";
    const task: BackgroundTaskSnapshot = {
      id: notification.task_id,
      toolUseId: notification.tool_use_id ?? previous?.toolUseId,
      description: previous?.description ?? notification.description ?? notification.summary,
      status: terminalStatus,
      isBackgrounded: previous?.isBackgrounded,
      startedAt: previous?.startedAt ?? Date.now(),
      endedAt: Date.now(),
      error:
        terminalStatus === "failed" ? (notification.summary ?? previous?.error) : previous?.error,
      summary: notification.summary ?? previous?.summary,
      outputFile: notification.output_file ?? previous?.outputFile,
      usage: notification.usage ?? previous?.usage,
      subagentType: previous?.subagentType,
    };
    session.backgroundTasks = boundBackgroundTaskHistory({
      ...session.backgroundTasks,
      [task.id]: task,
    });
    const owner = session.backgroundTaskControls?.get(task.id) ?? parked?.owner ?? correlated.owner;
    session.backgroundTaskControls?.delete(task.id);
    // The notification is injected into the same root loop and may be
    // followed by another assistant/result boundary. `Query.close()` is
    // destructive (it terminates the CLI and suppresses later frames),
    // so a released query must stay alive until that boundary arrives.
    // A later result closes held input, while abort/delete still closes
    // the control explicitly.
    if (owner === turn.queryIteratorControl && turn.turnReleasedToBackgroundTasks) {
      waitForContinuationAfterNotification(turn);
    } else {
      closeQueryControlIfUnused(session, owner);
    }
    emitBackgroundTasks();
  } else if (
    taskMessage.subtype === "background_tasks_changed" &&
    Array.isArray(taskMessage.tasks)
  ) {
    // A level signal replaces live membership only. Terminal bookends
    // are retained (within the bounded history) because the SDK permits
    // this level to arrive after the terminal edge for the same
    // transition; replacing the whole snapshot here erased failures and
    // could even resurrect the task as running.
    const replacement: Record<string, BackgroundTaskSnapshot> = Object.fromEntries(
      (
        Object.entries(session.backgroundTasks ?? {}) as Array<[string, BackgroundTaskSnapshot]>
      ).filter(([, task]) => !LIVE_BACKGROUND_TASK_STATUSES.has(task.status)),
    ) as Record<string, BackgroundTaskSnapshot>;
    const previousControls = session.backgroundTaskControls;
    const previousOwners = new Set(previousControls?.values() ?? []);
    const replacementControls = new Map<string, NonNullable<SessionState["queryControl"]>>();
    // The SDK documents this level signal as per-process. Every turn runs
    // on the session's one CLI, so it normally speaks for every live
    // task; a member owned by another control (a CLI still exiting while
    // its successor starts) is preserved, and only this query's slice is
    // replaced.
    const previouslyLiveOwnedByThisQuery: BackgroundTaskSnapshot[] = [];
    for (const [id, task] of Object.entries(session.backgroundTasks ?? {}) as Array<
      [string, BackgroundTaskSnapshot]
    >) {
      if (!LIVE_BACKGROUND_TASK_STATUSES.has(task.status)) continue;
      const owner = previousControls?.get(id);
      if ((owner && owner !== turn.queryIteratorControl!) || isHookRunningBackgroundTask(task)) {
        replacement[id] = task;
        if (owner) replacementControls.set(id, owner);
        continue;
      }
      // Owned by this query (or by no handle at all, which only this
      // query can still speak for). Whether it survives depends on the
      // payload below.
      previouslyLiveOwnedByThisQuery.push(task);
    }
    for (const entry of taskMessage.tasks) {
      const id = entry?.task_id;
      if (typeof id !== "string" || id.length === 0) continue;
      const previous = session.backgroundTasks?.[id];
      if (previous && !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status)) {
        replacement[id] = previous;
        continue;
      }
      // Only the level names the agent type (the edges do not), and it
      // never changes within a run, so an earlier value stands in for a
      // CLI that predates the field.
      const subagentType =
        typeof entry.subagent_type === "string" && entry.subagent_type.length > 0
          ? entry.subagent_type
          : previous?.subagentType;
      replacement[id] = {
        id,
        toolUseId: previous?.toolUseId,
        description: entry.description ?? previous?.description,
        status: LIVE_BACKGROUND_TASK_STATUSES.has(previous?.status ?? "running")
          ? (previous?.status ?? "running")
          : "running",
        isBackgrounded: previous?.isBackgrounded ?? true,
        startedAt: previous?.startedAt ?? Date.now(),
        ...(previous?.usage ? { usage: previous.usage } : {}),
        ...(subagentType ? { subagentType } : {}),
      };
      inheritBackgroundTaskHookRun(previous, replacement[id]!);
      // An id already owned by another live control keeps that owner:
      // only the process that started a task can stop it, and a control
      // asked to stop an id it never started answers `ok` without
      // reaching anything. This query claims genuinely new ids only.
      replacementControls.set(id, previousControls?.get(id) ?? turn.queryIteratorControl!);
    }
    session.backgroundTasks = boundBackgroundTaskHistory(replacement);
    session.backgroundTaskControls = replacementControls.size > 0 ? replacementControls : undefined;
    // Anything this query owned that the level no longer lists has
    // stopped running, but the level says nothing about *how* it ended.
    // The edge that does may still be on its way (the SDK leaves the
    // order unspecified; an edge that already landed made the task
    // terminal, so it is not in this list), so the query still owes a
    // continuation and must not be torn down
    // here — that close is what silently dropped the "I'll report back
    // when it finishes" reply the model had already promised.
    const droppedByThisQuery = previouslyLiveOwnedByThisQuery.filter(
      (task) => replacement[task.id] === undefined,
    );
    if (droppedByThisQuery.length > 0 && turn.turnReleasedToBackgroundTasks) {
      for (const task of droppedByThisQuery) {
        parkSettlingBackgroundTask(session, task, turn.queryIteratorControl!);
      }
      // Mirrors the `task_notification` branch: the earlier result is
      // only the boundary before this transition, not permission to
      // close streaming input. Closing it here lands stdin EOF between
      // the model's final tool result and its final assistant message,
      // which the rollout records as `[Request interrupted by user]`.
      turn.receivedResult = false;
      waitForContinuationAfterNotification(turn);
    }
    // Retention above is what keeps this query out of the close below:
    // `closeQueryControlIfUnused` treats a retained control as still in
    // use. Every other owner is closed exactly as before.
    for (const owner of previousOwners) {
      closeQueryControlIfUnused(session, owner);
    }
    emitBackgroundTasks();
  } else if (sysMsg.subtype === "thinking_tokens") {
    // A running estimate during the redacted-thinking phase, where the
    // API otherwise streams only pings. Arrives once per delta, so the
    // session keeps every value but publishes at most one per interval.
    const estimate = (message as SDKThinkingTokensMessage).estimated_tokens;
    if (
      ownsActiveTurn(turn) &&
      typeof estimate === "number" &&
      Number.isFinite(estimate) &&
      estimate >= 0
    ) {
      session.thinkingTokens = Math.round(estimate);
      const now = Date.now();
      if (now - turn.lastThinkingTokensEmitAt >= THINKING_TOKENS_EMIT_INTERVAL_MS) {
        turn.lastThinkingTokensEmitAt = now;
        eventEmitter.emit({
          type: "session.updated",
          sessionId,
          data: { thinkingTokens: session.thinkingTokens },
        });
      }
    }
  } else if (sysMsg.subtype === "status") {
    const status = message as SDKStatusMessage;
    setTurnActivity(turn, status.status === "compacting" ? "compacting" : undefined);
    // The compaction row is written by the PostCompact hook, which only
    // runs on success. A failed compaction left nothing in the tab while
    // the context stayed exactly as full as before.
    if (status.compact_result === "failed") {
      const reason = boundedNoticeText(status.compact_error);
      appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
        type: "status",
        severity: "warning",
        content: reason ? `Compaction failed: ${reason}` : "Compaction failed",
        createdAt: new Date().toISOString(),
      });
    }
    await reconcilePlanModeFromStatus(turn, status.permissionMode);
  } else if (sysMsg.subtype === "hook_response") {
    // Most of these are this bridge's own compaction and background-task
    // hooks. Only a failed or cancelled hook says something is broken.
    if ((message as SDKHookResponseMessage).outcome !== "success") {
      recordSystemMessageNotice(session, sysMsg);
    }
  } else if (sysMsg.subtype === "informational") {
    const info = message as SDKInformationalMessage;
    const content = boundedNoticeText(info.content);
    // `info` renders only in the CLI's verbose transcript mode and
    // `notice` in inactive gray: inventory, not something to interrupt
    // the tab with. A stopped continuation is always shown, because the
    // turn ends on it and nothing else would say why.
    const visible =
      info.prevent_continuation === true || info.level === "warning" || info.level === "suggestion";
    if (content && visible) {
      const part: NormalizedPart = {
        type: "status",
        severity:
          info.prevent_continuation === true || info.level === "warning" ? "warning" : "info",
        content,
        createdAt: new Date().toISOString(),
      };
      // The SDK repeats a progress line for one tool use; keep one row.
      const existingId = info.tool_use_id
        ? turn.informationalRowsByToolUse.get(info.tool_use_id)
        : undefined;
      const existing = existingId
        ? session.messages.find((candidate) => candidate.id === existingId)
        : undefined;
      if (existing) {
        existing.content = part.content;
        existing.parts = [part];
        markTranscriptChanged(session);
        eventEmitter.emit({
          type: "message.updated",
          sessionId,
          data: { message: existing },
        });
      } else {
        const row = appendTranscriptNotice(
          session,
          sessionId,
          (event) => eventEmitter.emit(event),
          part,
        );
        if (info.tool_use_id) turn.informationalRowsByToolUse.set(info.tool_use_id, row.id);
      }
    } else {
      recordSystemMessageNotice(session, sysMsg);
    }
  } else if (sysMsg.subtype === "permission_denied") {
    const denial = message as SDKPermissionDeniedMessage;
    // The tool result that follows carries the rejection the model read.
    // What only this frame says is *who* decided and why, so that is
    // what is kept on the call, where the renderer shows it.
    const reason = boundedNoticeText(denial.decision_reason ?? denial.message);
    // PreToolUse ran before the permission decision; no PostToolUse
    // will close the window it opened.
    if (typeof denial.tool_use_id === "string") {
      commandChangeProbe.discard(denial.tool_use_id);
    }
    const marked =
      typeof denial.tool_use_id === "string" &&
      toolTracker.recordDenial(denial.tool_use_id, {
        reason,
        ...(typeof denial.decision_reason_type === "string"
          ? { source: denial.decision_reason_type.slice(0, 64) }
          : {}),
      });
    if (marked) {
      const refreshed = stream.refreshToolRows([denial.tool_use_id]);
      refreshSettledToolRows(session, sessionId, toolTracker, [denial.tool_use_id], refreshed);
    } else {
      // A call this turn never saw (a subagent's, or one from before a
      // reconnect) still deserves to say it was refused.
      const toolName = boundedNoticeText(denial.tool_name) ?? "A tool call";
      appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
        type: "status",
        severity: "warning",
        content: reason ? `${toolName} was denied: ${reason}` : `${toolName} was denied`,
        createdAt: new Date().toISOString(),
      });
    }
  } else if (sysMsg.subtype === "memory_recall") {
    const recall = message as SDKMemoryRecallMessage;
    const memories = Array.isArray(recall.memories) ? recall.memories : [];
    if (memories.length > 0) {
      appendTranscriptNotice(
        session,
        sessionId,
        (event) => eventEmitter.emit(event),
        memoryRecallPart(recall.mode, memories),
      );
    }
  }
  finishTurnInputIfSettled(turn);

  // System subtypes with no branch above are diagnostics, not transcript
  // content. They used to be re-emitted as an untyped `system.message`
  // frame carrying the whole SDK message — which nothing consumed, and
  // which put arbitrary provider payload on the wire. Record them as
  // runtime notices instead, where they are bounded, redacted, carry a
  // severity, and reach the health panel. Only errors are additionally
  // raised in the tab by the backend. Which subtypes are recorded at all
  // is `SYSTEM_SUBTYPE_DISPOSITIONS`, applied at the end of this branch.
  if (sysMsg.subtype === "api_retry") {
    // A retry the user can see, rather than a silent stall. Recorded as a
    // pending row and settled by the next assistant message or by the
    // turn's own outcome — a retry row that never settles is exactly the
    // stale card this replaces.
    const retry = sysMsg as unknown as SDKAPIRetryMessage;
    // A later retry proves the preceding attempt failed. Settle that row
    // before opening the next one so no superseded spinner can survive.
    settlePendingApiRetry(session, sessionId, (event) => eventEmitter.emit(event), stream, {
      state: "failure",
    });
    stream.pendingApiRetryMessageId = appendTranscriptNotice(
      session,
      sessionId,
      (event) => eventEmitter.emit(event),
      {
        type: "retry",
        content:
          typeof retry.error_status === "number"
            ? `The API answered ${retry.error_status}`
            : "The API request failed",
        toolState: "pending",
        ...(typeof retry.attempt === "number" ? { retryAttempt: retry.attempt } : {}),
        createdAt: new Date().toISOString(),
      },
    ).id;
  }
  const disposition = systemSubtypeDisposition(sysMsg.subtype);
  if (disposition === undefined) {
    // A subtype newer than the table: counted as drift, and still kept
    // as a notice so whatever it said is not lost.
    sessionHealth(session).recordUnknown(`system:${sysMsg.subtype ?? "(untyped)"}`);
    recordSystemMessageNotice(session, sysMsg);
  } else if (disposition === "notice" || disposition === "handled+notice") {
    recordSystemMessageNotice(session, sysMsg);
  }
}
