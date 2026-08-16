import * as shared from "./tmux-shared.js";
import * as backend from "./tmux-backend.js";
import * as hooks from "./tmux-hooks.js";
import * as sessionManager from "./tmux-session-manager.js";
import * as interactive from "./tmux-interactive.js";
import * as poll from "./tmux-poll.js";
const {
  existsSync,
  fs,
  path,
  os,
  createHash,
  randomUUID,
  spawn,
  delay,
  ORKESTRATOR_AGENT_MCP_SERVER_NAME,
  runCommand,
  TranscriptTaskTracker,
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  parseTmuxAgentObservation,
  parseTmuxSelectionPrompt,
  tmuxSelectionPromptFingerprint,
  CLAUDE_TMUX_EVENT,
  POLL_INTERVAL_MS,
  TMUX_OBSERVATION_INTERVAL_MS,
  TMUX_BUSY_OBSERVATION_INTERVAL_MS,
  LIVENESS_CHECK_EVERY_TICKS,
  HOOK_TIMEOUT_SECS,
  COMMAND_IDLE_TIMEOUT_MS,
  COMMAND_NO_HOOK_SETTLE_MS,
  COMMAND_AFTER_IDLE_SETTLE_MS,
  PERMISSION_MODE_SWITCH_TIMEOUT_MS,
  PERMISSION_MODE_POLL_MS,
  FAST_MODE_SWITCH_TIMEOUT_MS,
  FAST_MODE_POLL_MS,
  FAST_MODE_TMUX_OPTION,
  BACKUP_SENTINEL_NO_ORIGINAL,
  CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN,
  RUNTIME_ROOT_PREFIX,
  claudeTmuxRuntimeRootPrefix,
  agentMcpConfigJson,
  agentToolConnectionTarget,
  runtimeRootPrefixForContext,
  isMissingTmuxSessionError,
  THINKING_MODE_ARGS,
  THINKING_DISPLAY_FLAG,
  THINKING_DISPLAY_VALUE,
  THINKING_DISPLAY_PROBE_VALUE,
  THINKING_DISPLAY_PROBE_TIMEOUT_MS,
  HOOK_EVENT_KINDS,
  containerExecArgs,
  asString,
  asOptionalString,
  asBoolean,
  asPositiveInt,
  asNonNegativeInt,
  asStringArray,
  shellArg,
  shellDq,
  readableIdPrefix,
  tmuxSessionName,
  tmuxSessionNamePrefix,
  parseTmuxSessionNames,
  selectReapableTmuxSessions,
  isBlockingHook,
  parseEventFilename,
  responseFilename,
  pathDirname,
  bytesPayload,
  countNewlines,
  execWithOutput,
  execWithRawOutput,
  POLL_SNAPSHOT_PENDING_MARKER,
  POLL_SNAPSHOT_TIMEOUT_MARKER,
  POLL_SNAPSHOT_SIZE_MARKER,
  pollSnapshotScript,
  parsePollSnapshotOutput,
  parsePollSnapshotExecOutput,
  tailFromOffsetCommand,
  TRANSCRIPT_HEAD_MARKER,
  transcriptHeadCommand,
  parseTranscriptHeadOutput,
  MAX_PREVIOUS_SESSIONS,
  PREVIOUS_SESSION_STAT_CONCURRENCY,
  jsonlByMtimeFindCommand,
  isDirectJsonlChild,
  listLocalJsonlByMtime,
  parseFreshJsonlFindOutput,
  INTERACTIVE_KEY_SEQUENCES,
  sendInteractiveData,
  TmuxBackend,
  TMUX_HOOK_PAYLOAD_MAX_BYTES,
  TMUX_HOOK_TIMING_MAX_BYTES,
  blockingHookTiming,
  parseBlockingHookTiming,
  readBlockingHookTiming,
  workspaceHookPaths,
  sessionHookPaths,
  hookScript,
  hooksBlock,
  mergeSettingsJson,
  gitExcludeSetupScript,
  ensureClaudeSettingsGitIgnored,
  installWorkspaceHooks,
  uninstallWorkspaceHooks,
  restoreWorkspaceHooks,
  ensureSessionDirs,
  drainTimeouts,
  drainPending,
  listPendingBlocking,
  replyToHook,
  preToolUseResponse,
  failClosedHookResponse,
  encodeCwd,
  localClaudeHome,
  findTranscriptPath,
  newestJsonlFindCommand,
  newestJsonlInDir,
  transcriptContainsSessionId,
  jsonContainsSessionId,
  TRANSCRIPT_HEAD_BYTES,
  listPreviousSessions,
  titleFromTranscriptHead,
  extractTextContent,
  truncateTitle,
  TranscriptTail,
  TMUX_INFO_EVENT_LIMIT,
  TMUX_INFO_EVENT_MESSAGE_MAX_UNITS,
  boundedInfoEventMessage,
  permissionModeFromTranscriptLine,
  permissionModeFromPane,
  thinkingDisplayProbeArgs,
  thinkingDisplayProbeIndicatesSupport,
  probeThinkingDisplaySupport,
  TmuxSession,
  stripAnsi,
  paneOutputAfterCommand,
  fastModeFromPane,
  fastModeRejectionFromPane,
  paneHasSelectionPrompt,
  paneHasClaudeExited,
  AsyncMutex,
  TmuxSessionManager,
  tmuxManager,
  tmuxActivityWrites,
  orphanedTmuxMissingSince,
  lastTmuxOrphanSweepAt,
  persistTmuxEnvironmentActivity,
  workspaceAndClaudeHome,
  resolveBackend,
  resolveBundledClaudePath,
  resolvePinnedClaudeCommand,
  getOrCreateSession,
  killOrphanSession,
  killEnvironmentTmuxSessions,
  getLastTmuxOrphanSweepAt,
  setLastTmuxOrphanSweepAt,
  INTERACTIVE_SNAPSHOT_MIN_MS,
  INTERACTIVE_SNAPSHOT_MAX_MS,
  paneRows,
  buildTmuxPaneUpdate,
  InteractiveTmuxTerminalManager,
  interactiveTerminals,
  detachInteractiveTerminalsForEnvironment,
  CLAUDE_STATE_READ_TIMEOUT_MS,
  CLAUDE_STATE_POLL_INTERVAL_MS,
  CLAUDE_STATE_RETIREMENT_CHECK_MS,
  claudeStateReadCommand,
  ClaudeStatePollManager,
  defaultClaudeStatePolls,
  shutdownClaudeStatePolling,
  environmentContainerId,
} = Object.assign({}, shared, backend, hooks, sessionManager, interactive, poll);
void [existsSync, fs, path, os, createHash, randomUUID, spawn, delay, ORKESTRATOR_AGENT_MCP_SERVER_NAME, runCommand, TranscriptTaskTracker, AGENT_INTERACTION_DEFAULT_TIMEOUT_MS, parseTmuxAgentObservation, parseTmuxSelectionPrompt, tmuxSelectionPromptFingerprint, CLAUDE_TMUX_EVENT, POLL_INTERVAL_MS, TMUX_OBSERVATION_INTERVAL_MS, TMUX_BUSY_OBSERVATION_INTERVAL_MS, LIVENESS_CHECK_EVERY_TICKS, HOOK_TIMEOUT_SECS, COMMAND_IDLE_TIMEOUT_MS, COMMAND_NO_HOOK_SETTLE_MS, COMMAND_AFTER_IDLE_SETTLE_MS, PERMISSION_MODE_SWITCH_TIMEOUT_MS, PERMISSION_MODE_POLL_MS, FAST_MODE_SWITCH_TIMEOUT_MS, FAST_MODE_POLL_MS, FAST_MODE_TMUX_OPTION, BACKUP_SENTINEL_NO_ORIGINAL, CLAUDE_SETTINGS_LOCAL_GIT_EXCLUDE_PATTERN, RUNTIME_ROOT_PREFIX, claudeTmuxRuntimeRootPrefix, agentMcpConfigJson, agentToolConnectionTarget, runtimeRootPrefixForContext, isMissingTmuxSessionError, THINKING_MODE_ARGS, THINKING_DISPLAY_FLAG, THINKING_DISPLAY_VALUE, THINKING_DISPLAY_PROBE_VALUE, THINKING_DISPLAY_PROBE_TIMEOUT_MS, HOOK_EVENT_KINDS, containerExecArgs, asString, asOptionalString, asBoolean, asPositiveInt, asNonNegativeInt, asStringArray, shellArg, shellDq, readableIdPrefix, tmuxSessionName, tmuxSessionNamePrefix, parseTmuxSessionNames, selectReapableTmuxSessions, isBlockingHook, parseEventFilename, responseFilename, pathDirname, bytesPayload, countNewlines, execWithOutput, execWithRawOutput, POLL_SNAPSHOT_PENDING_MARKER, POLL_SNAPSHOT_TIMEOUT_MARKER, POLL_SNAPSHOT_SIZE_MARKER, pollSnapshotScript, parsePollSnapshotOutput, parsePollSnapshotExecOutput, tailFromOffsetCommand, TRANSCRIPT_HEAD_MARKER, transcriptHeadCommand, parseTranscriptHeadOutput, MAX_PREVIOUS_SESSIONS, PREVIOUS_SESSION_STAT_CONCURRENCY, jsonlByMtimeFindCommand, isDirectJsonlChild, listLocalJsonlByMtime, parseFreshJsonlFindOutput, INTERACTIVE_KEY_SEQUENCES, sendInteractiveData, TmuxBackend, TMUX_HOOK_PAYLOAD_MAX_BYTES, TMUX_HOOK_TIMING_MAX_BYTES, blockingHookTiming, parseBlockingHookTiming, readBlockingHookTiming, workspaceHookPaths, sessionHookPaths, hookScript, hooksBlock, mergeSettingsJson, gitExcludeSetupScript, ensureClaudeSettingsGitIgnored, installWorkspaceHooks, uninstallWorkspaceHooks, restoreWorkspaceHooks, ensureSessionDirs, drainTimeouts, drainPending, listPendingBlocking, replyToHook, preToolUseResponse, failClosedHookResponse, encodeCwd, localClaudeHome, findTranscriptPath, newestJsonlFindCommand, newestJsonlInDir, transcriptContainsSessionId, jsonContainsSessionId, TRANSCRIPT_HEAD_BYTES, listPreviousSessions, titleFromTranscriptHead, extractTextContent, truncateTitle, TranscriptTail, TMUX_INFO_EVENT_LIMIT, TMUX_INFO_EVENT_MESSAGE_MAX_UNITS, boundedInfoEventMessage, permissionModeFromTranscriptLine, permissionModeFromPane, thinkingDisplayProbeArgs, thinkingDisplayProbeIndicatesSupport, probeThinkingDisplaySupport, TmuxSession, stripAnsi, paneOutputAfterCommand, fastModeFromPane, fastModeRejectionFromPane, paneHasSelectionPrompt, paneHasClaudeExited, AsyncMutex, TmuxSessionManager, tmuxManager, tmuxActivityWrites, orphanedTmuxMissingSince, lastTmuxOrphanSweepAt, persistTmuxEnvironmentActivity, workspaceAndClaudeHome, resolveBackend, resolveBundledClaudePath, resolvePinnedClaudeCommand, getOrCreateSession, killOrphanSession, killEnvironmentTmuxSessions, getLastTmuxOrphanSweepAt, setLastTmuxOrphanSweepAt, INTERACTIVE_SNAPSHOT_MIN_MS, INTERACTIVE_SNAPSHOT_MAX_MS, paneRows, buildTmuxPaneUpdate, InteractiveTmuxTerminalManager, interactiveTerminals, detachInteractiveTerminalsForEnvironment, CLAUDE_STATE_READ_TIMEOUT_MS, CLAUDE_STATE_POLL_INTERVAL_MS, CLAUDE_STATE_RETIREMENT_CHECK_MS, claudeStateReadCommand, ClaudeStatePollManager, defaultClaudeStatePolls, shutdownClaudeStatePolling, environmentContainerId];
type CommandContext = shared.CommandContext;
type AgentToolConnection = shared.AgentToolConnection;
type Environment = shared.Environment;
type JsonRecord = shared.JsonRecord;
type TaskListSnapshot = shared.TaskListSnapshot;
type TmuxAgentObservation = shared.TmuxAgentObservation;
type TranscriptTaskTracker = shared.TranscriptTaskTracker;
type CommandHandler = shared.CommandHandler;
type RegisterCommand = shared.RegisterCommand;
type ExecOutput = shared.ExecOutput;
type BackendKind = shared.BackendKind;
type RawExecOutput = shared.RawExecOutput;
type TmuxPollSnapshot = shared.TmuxPollSnapshot;
type SessionHookPaths = shared.SessionHookPaths;
type TmuxBackend = backend.TmuxBackend;
type WorkspaceHookPaths = hooks.WorkspaceHookPaths;
type PendingHookEvent = hooks.PendingHookEvent;
type TmuxStatus = hooks.TmuxStatus;
type ProbeExec = hooks.ProbeExec;
type TranscriptTail = hooks.TranscriptTail;
type TmuxSession = sessionManager.TmuxSession;
type TmuxSessionManager = sessionManager.TmuxSessionManager;
type AsyncMutex = sessionManager.AsyncMutex;
type TmuxPaneUpdate = interactive.TmuxPaneUpdate;
type InteractiveTerminalSession = interactive.InteractiveTerminalSession;
type InteractiveTmuxTerminalManagerOptions = interactive.InteractiveTmuxTerminalManagerOptions;
type ClaudeStatePoll = poll.ClaudeStatePoll;
type InteractiveTmuxTerminalManager = interactive.InteractiveTmuxTerminalManager;
type ClaudeStatePollManagerOptions = poll.ClaudeStatePollManagerOptions;
type ClaudeStatePollManager = poll.ClaudeStatePollManager;
export type CommandsTmuxLayerTypes = [
  CommandContext,
  AgentToolConnection,
  Environment,
  JsonRecord,
  TaskListSnapshot,
  TmuxAgentObservation,
  TranscriptTaskTracker,
  CommandHandler,
  RegisterCommand,
  ExecOutput,
  BackendKind,
  RawExecOutput,
  TmuxPollSnapshot,
  SessionHookPaths,
  TmuxBackend,
  WorkspaceHookPaths,
  PendingHookEvent,
  TmuxStatus,
  ProbeExec,
  TranscriptTail,
  TmuxSession,
  TmuxSessionManager,
  AsyncMutex,
  TmuxPaneUpdate,
  InteractiveTerminalSession,
  InteractiveTmuxTerminalManagerOptions,
  ClaudeStatePoll,
  InteractiveTmuxTerminalManager,
  ClaudeStatePollManagerOptions,
  ClaudeStatePollManager,
];

/**
 * Tears down every claude-tmux artefact an environment owns during deletion.
 *
 * The container and worktree must still exist while this runs: tmux sessions
 * need the live backend, and the user's Claude settings may need restoration.
 */
export async function cleanupEnvironmentTmux(
  environmentId: string,
  context: CommandContext,
): Promise<void> {
  await tmuxManager.installLock(environmentId).runExclusive(async () => {
    detachInteractiveTerminalsForEnvironment(environmentId);
    const environment = await context.storage.getEnvironment(environmentId);
    if (
      environment?.environmentType === "containerized"
      && environment.status === "stopped"
    ) {
      tmuxManager.removeEnvironment(environmentId);
      return;
    }

    let cleanupComplete = true;
    for (const session of tmuxManager.removeEnvironment(environmentId)) {
      const stopped = await session.stop().catch((error: unknown) => {
        console.warn("[tmux] session stop failed during environment cleanup", error);
        return false;
      });
      if (!stopped) cleanupComplete = false;
    }

    let backend: TmuxBackend;
    try {
      backend = await resolveBackend(environmentId, context);
    } catch (error) {
      console.debug("[tmux] skipping environment tmux cleanup", error);
      return;
    }

    let survivingEnvironmentIds: string[];
    try {
      survivingEnvironmentIds = (await context.storage.loadEnvironments())
        .map((remainingEnvironment) => remainingEnvironment.id);
    } catch (error) {
      cleanupComplete = false;
      survivingEnvironmentIds = [];
      console.warn("[tmux] failed to load environments during tmux cleanup", error);
    }

    if (cleanupComplete) {
      const result = await killEnvironmentTmuxSessions(
        backend,
        environmentId,
        survivingEnvironmentIds,
      ).catch((error: unknown) => {
        cleanupComplete = false;
        console.warn("[tmux] failed to kill environment tmux sessions", error);
        return { killed: [], complete: false };
      });
      cleanupComplete = cleanupComplete && result.complete;
    }

    const { workspace } = workspaceAndClaudeHome(backend);
    const hookPaths = workspaceHookPaths(
      path.join(runtimeRootPrefixForContext(context), environmentId),
      workspace,
    );
    await restoreWorkspaceHooks(backend, hookPaths).catch((error: unknown) => {
      cleanupComplete = false;
      console.warn("[tmux] uninstallWorkspaceHooks failed during environment cleanup", error);
    });
    if (cleanupComplete) {
      await backend.removeFile(hookPaths.claudeSettingsBackup).catch(() => undefined);
      await backend.removeDir(hookPaths.root).catch(() => undefined);
    } else {
      throw new Error(`claude-tmux cleanup incomplete for environment ${environmentId}`);
    }
  });
}

export function registerTmuxBackendCommands(
  register: RegisterCommand,
  options: { claudeStatePolls?: ClaudeStatePollManager } = {},
): void {
  // Tests inject a manager so the polling commands can be exercised without a
  // Docker daemon; production keeps the single process-wide instance.
  const claudeStatePolls = options.claudeStatePolls ?? defaultClaudeStatePolls;
  register("reconcile_claude_state_polling", (_args, context) =>
    claudeStatePolls.reconcile(context),
  );

  register("claude_tmux_start", async ({
    tabId,
    environmentId,
    initialPrompt,
    model,
    effort,
    fastMode,
    resumeSessionId,
    replaceExisting,
  }, context) => {
    const envId = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
    const resumeId = asOptionalString(resumeSessionId);
    const replace = replaceExisting === true;
    return tmuxManager.installLock(envId).runExclusive(async () => {
      const environment = await context.storage.getEnvironment(envId);
      if (!environment || environment.deletionRequestedAt) {
        throw new Error(`environment ${envId} is being deleted`);
      }
      if (replace) {
        const existing = tmuxManager.remove(envId, tab);
        if (existing) await existing.stop();
        else await killOrphanSession(context, envId, tab);
      }

      const session = await getOrCreateSession(context, envId, tab, resumeId);
      await installWorkspaceHooks(session.backend, session.workspaceHookPaths);
      await session.startAfterHooksInstalled(
        context,
        asOptionalString(initialPrompt),
        asOptionalString(model),
        asOptionalString(effort),
        typeof fastMode === "boolean" ? fastMode : undefined,
      );
      await persistTmuxEnvironmentActivity(context, envId);
      return session.status(await session.tmuxAlive().catch(() => false));
    });
  });

  register("claude_tmux_stop", async ({ tabId, environmentId }, context) => {
    const envId = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
    await tmuxManager.installLock(envId).runExclusive(async () => {
      // Start inserts its session before installing hooks and probing the
      // executables. Removing outside this lock lets stop kill "nothing" while
      // that start is paused, after which start can launch an untracked tmux
      // process. Serialize the complete stop transition with start/replace.
      const session = tmuxManager.remove(envId, tab);
      if (!session) {
        await killOrphanSession(context, envId, tab);
      } else {
        await session.stop();
      }
      if (session && tmuxManager.sessionsInEnvironment(envId) === 0) {
        await uninstallWorkspaceHooks(session.backend, session.workspaceHookPaths).catch((error: unknown) => {
          console.warn("[tmux] uninstallWorkspaceHooks failed", error);
        });
      }
      await persistTmuxEnvironmentActivity(context, envId);
    });
  });

  register("claude_tmux_interrupt", async ({ tabId, environmentId }, context) => {
    const envId = asString(environmentId, "environmentId");
    await requireSession(envId, asString(tabId, "tabId")).interrupt();
    await persistTmuxEnvironmentActivity(context, envId);
  });
  register("claude_tmux_status", async ({ tabId, environmentId }) => {
    const session = tmuxManager.get(asString(environmentId, "environmentId"), asString(tabId, "tabId"));
    return session ? session.status(await session.tmuxAlive().catch(() => false)) : null;
  });
  register("claude_tmux_transcript", ({ tabId, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).transcriptLines(),
  );
  // Authoritative task list for a tmux tab, for callers rehydrating without
  // replaying the whole transcript.
  register("claude_tmux_tasks", ({ tabId, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).taskList(),
  );
  register("claude_tmux_pending_hooks", ({ tabId, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).pendingHooks(),
  );
  register("claude_tmux_send_text", ({ tabId, text, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).sendText(asString(text, "text")),
  );
  register("claude_tmux_send_keys", ({ tabId, keys, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId"))
      .sendKeysAndRefresh(asStringArray(keys)),
  );
  register("claude_tmux_answer_selection_prompt", ({
    tabId,
    environmentId,
    expectedGeneration,
    expectedRevision,
    expectedPromptFingerprint,
    optionIndex,
  }) => requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId"))
    .answerSelectionPrompt({
      expectedGeneration: asString(expectedGeneration, "expectedGeneration"),
      expectedRevision: asNonNegativeInt(expectedRevision, "expectedRevision"),
      expectedPromptFingerprint: asString(expectedPromptFingerprint, "expectedPromptFingerprint"),
      optionIndex: asNonNegativeInt(optionIndex, "optionIndex"),
    }));
  register("claude_tmux_submit", async ({ tabId, text, environmentId }, context) => {
    const envId = asString(environmentId, "environmentId");
    await requireSession(envId, asString(tabId, "tabId")).submit(asString(text, "text"));
    await persistTmuxEnvironmentActivity(context, envId);
  });
  register("claude_tmux_submit_queued", async ({ tabId, text, environmentId }, context) => {
    const envId = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
    const prompt = asString(text, "text");
    // Serialize the final liveness check and terminal side effect with tmux
    // teardown. Deletion writes its tombstone before taking this same lock, so
    // a queued dispatch can never type into a pane after deletion has begun.
    await tmuxManager.installLock(envId).runExclusive(async () => {
      const environment = await context.storage.getEnvironment(envId);
      if (!environment || environment.deletionRequestedAt) {
        throw new Error(`environment ${envId} is being deleted`);
      }
      await requireSession(envId, tab).submit(prompt);
      await persistTmuxEnvironmentActivity(context, envId);
    });
  });
  register("claude_tmux_switch_model", ({ tabId, model, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).switchModel(asString(model, "model")),
  );
  register("claude_tmux_switch_effort", ({ tabId, effort, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).switchEffort(asString(effort, "effort")),
  );
  register("claude_tmux_switch_fast_mode", ({ tabId, fastMode, environmentId }, context) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).switchFastMode(
      asBoolean(fastMode, "fastMode"),
      context,
    ),
  );
  register("claude_tmux_switch_plan_mode", ({ tabId, planMode, environmentId }, context) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).switchPlanMode(
      asBoolean(planMode, "planMode"),
      context,
    ),
  );
  register("claude_tmux_resize", ({ tabId, cols, rows, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).resize(
      asPositiveInt(cols, "cols"),
      asPositiveInt(rows, "rows"),
    ),
  );
  register("claude_tmux_answer_pre_tool_use", ({ tabId, eventId, decision, reason, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).answerPreToolUse(
      asString(eventId, "eventId"),
      asString(decision, "decision"),
      asOptionalString(reason),
    ),
  );
  register("claude_tmux_reply_hook", ({ tabId, eventKind, eventId, response, environmentId }) =>
    requireSession(asString(environmentId, "environmentId"), asString(tabId, "tabId")).replyHook(
      asString(eventKind, "eventKind"),
      asString(eventId, "eventId"),
      response,
    ),
  );
  register("claude_tmux_list_previous_sessions", async ({ environmentId }, context) => {
    const backend = await resolveBackend(asString(environmentId, "environmentId"), context);
    const paths = workspaceAndClaudeHome(backend);
    return listPreviousSessions(backend, paths.claudeHome, paths.workspace);
  });
  register("claude_tmux_reconcile_orphans", async (_args, context) => {
    const now = Date.now();
    if (now - getLastTmuxOrphanSweepAt() < 60_000) return { reaped: 0, skipped: true };
    setLastTmuxOrphanSweepAt(now);
    const graceMs = 60 * 60 * 1_000;
    const environments = await context.storage.loadEnvironments();
    const paneLayouts = await context.storage.loadPaneLayoutsForReconciliation();
    if (!paneLayouts.available) {
      console.warn("[tmux] skipping orphan reconciliation because pane layouts are unreadable");
      return { reaped: 0, skipped: true };
    }
    const survivingIds = environments.map((environment) => environment.id);
    let reaped = 0;

    const collectReferencedNames = (
      environmentId: string,
      node: unknown,
      names: Set<string>,
    ): void => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const record = node as Record<string, unknown>;
      if (record.kind === "leaf" && Array.isArray(record.tabs)) {
        for (const tab of record.tabs) {
          if (!tab || typeof tab !== "object" || Array.isArray(tab)) continue;
          const candidate = tab as Record<string, unknown>;
          if (candidate.type === "claude-tmux" && typeof candidate.id === "string") {
            names.add(tmuxSessionName(environmentId, candidate.id));
          }
        }
        return;
      }
      if (record.kind === "split" && Array.isArray(record.children)) {
        for (const child of record.children) {
          collectReferencedNames(environmentId, child, names);
        }
      }
    };

    for (const environment of environments) {
      let backend: TmuxBackend;
      try {
        backend = await resolveBackend(environment.id, context);
      } catch {
        continue;
      }
      const listed = await backend.exec(["tmux", "list-sessions", "-F", "#{session_name}"])
        .catch(() => null);
      if (!listed) continue;
      if (listed.status !== 0 && !isMissingTmuxSessionError(listed.stderr)) continue;
      const layout = paneLayouts.layouts[environment.id];
      const referenced = new Set<string>();
      if (layout) collectReferencedNames(environment.id, layout.root, referenced);
      const names = selectReapableTmuxSessions({
        names: listed.status === 0 ? parseTmuxSessionNames(listed.stdout) : [],
        environmentId: environment.id,
        survivingEnvironmentIds: survivingIds,
      });
      const remaining = new Set(names);
      for (const name of names) {
        const key = `${environment.id}\0${name}`;
        if (referenced.has(name)) {
          orphanedTmuxMissingSince.delete(key);
          continue;
        }
        const missingSince = orphanedTmuxMissingSince.get(key);
        if (missingSince === undefined) {
          orphanedTmuxMissingSince.set(key, now);
          continue;
        }
        if (now - missingSince < graceMs) continue;
        const managed = tmuxManager.findByTmuxName(environment.id, name);
        if (managed) {
          const stopped = await tmuxManager.installLock(environment.id).runExclusive(async () => {
            if (tmuxManager.findByTmuxName(environment.id, name) !== managed) return false;
            if (!await managed.stop()) return false;
            return tmuxManager.removeIfSame(environment.id, managed.tabId, managed);
          });
          if (!stopped) continue;
        } else {
          const killed = await backend.exec(["tmux", "kill-session", "-t", name]);
          if (killed.status !== 0) continue;
        }
        remaining.delete(name);
        orphanedTmuxMissingSince.delete(key);
        console.warn(`[tmux] reaped orphaned session ${environment.id}/${name}`);
        reaped += 1;
      }
      if (remaining.size === 0 && tmuxManager.sessionsInEnvironment(environment.id) === 0) {
        const { workspace } = workspaceAndClaudeHome(backend);
        const hookPaths = workspaceHookPaths(
          path.join(runtimeRootPrefixForContext(context), environment.id),
          workspace,
        );
        await uninstallWorkspaceHooks(backend, hookPaths).catch(() => undefined);
      }
    }
    return { reaped, skipped: false };
  });
  register("claude_tmux_create_interactive_terminal", async ({ tabId, environmentId, cols, rows }, context) => {
    const envId = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
    const session = requireSession(envId, tab);
    if (!await session.tmuxAlive()) throw new Error("tmux session not running");
    const environment = await context.storage.getEnvironment(envId);
    if (environment?.environmentType !== "local" && !environmentContainerId(environment)) {
      throw new Error("container environment has no container id");
    }
    return interactiveTerminals.create(session, asPositiveInt(cols, "cols"), asPositiveInt(rows, "rows"));
  });
  register("claude_tmux_start_interactive_terminal", ({ terminalSessionId }, context) =>
    interactiveTerminals.start(asString(terminalSessionId, "terminalSessionId"), context),
  );
  register("claude_tmux_write_interactive_terminal", ({ terminalSessionId, data }) =>
    interactiveTerminals.write(asString(terminalSessionId, "terminalSessionId"), asString(data, "data")),
  );
  register("claude_tmux_resize_interactive_terminal", ({ terminalSessionId, cols, rows }) =>
    interactiveTerminals.resize(
      asString(terminalSessionId, "terminalSessionId"),
      asPositiveInt(cols, "cols"),
      asPositiveInt(rows, "rows"),
    ),
  );
  register("claude_tmux_detach_interactive_terminal", ({ terminalSessionId }) => {
    interactiveTerminals.detach(asString(terminalSessionId, "terminalSessionId"));
  });
}

export function requireSession(environmentId: string, tabId: string): TmuxSession {
  const session = tmuxManager.get(environmentId, tabId);
  if (!session) throw new Error("tmux session not running");
  return session;
}
