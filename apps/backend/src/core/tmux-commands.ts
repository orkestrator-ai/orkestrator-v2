import {
  claudeTmuxAnswerPreToolUseCommand,
  claudeTmuxAnswerSelectionPromptCommand,
  claudeTmuxCreateInteractiveTerminalCommand,
  claudeTmuxDetachInteractiveTerminalCommand,
  claudeTmuxHoldHookCommand,
  claudeTmuxInterruptCommand,
  claudeTmuxListPreviousSessionsCommand,
  claudeTmuxPendingHooksCommand,
  claudeTmuxReconcileOrphansCommand,
  claudeTmuxReplyHookCommand,
  claudeTmuxResizeCommand,
  claudeTmuxResizeInteractiveTerminalCommand,
  claudeTmuxSendKeysCommand,
  claudeTmuxSendTextCommand,
  claudeTmuxStartCommand,
  claudeTmuxStartInteractiveTerminalCommand,
  claudeTmuxStatusCommand,
  claudeTmuxStopCommand,
  claudeTmuxSubmitCommand,
  claudeTmuxSubmitQueuedCommand,
  claudeTmuxSwitchEffortCommand,
  claudeTmuxSwitchFastModeCommand,
  claudeTmuxSwitchModelCommand,
  claudeTmuxSwitchPlanModeCommand,
  claudeTmuxTasksCommand,
  claudeTmuxTranscriptCommand,
  claudeTmuxWriteInteractiveTerminalCommand,
  reconcileClaudeStatePollingCommand,
} from "@orkestrator/protocol/contract/domains/claude-tmux";
import type { ResultOf } from "@orkestrator/protocol/contract/command";
import { wrapRegistrar } from "./commands-registry-contracts.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import * as shared from "./tmux-shared.js";
import * as hooks from "./tmux-hooks.js";
import * as interactive from "./tmux-interactive.js";
import * as poll from "./tmux-poll.js";
import {
  TranscriptTaskTracker,
  asNonNegativeInt,
  asOptionalString,
  asPositiveInt,
  asString,
  asStringArray,
  confirmTmuxSessionGone,
  parseTmuxSessionNames,
  path,
  runtimeRootPrefixForContext,
  selectReapableTmuxSessions,
  tmuxSessionName,
} from "./tmux-shared.js";
import { TmuxBackend } from "./tmux-backend.js";
import {
  TranscriptTail,
  encodeCwd,
  installWorkspaceHooks,
  listPreviousSessions,
  restoreWorkspaceHooks,
  uninstallWorkspaceHooks,
  workspaceHookPaths,
} from "./tmux-hooks.js";
import {
  AsyncMutex,
  TmuxSession,
  TmuxSessionManager,
  type TmuxSessionTimingOptions,
  getOrCreateSession,
  killEnvironmentTmuxSessions,
  killOrphanSession,
  resolveBackend,
  workspaceAndClaudeHome,
} from "./tmux-session-manager.js";
import { TmuxTranscriptReader } from "./tmux-transcript-reader.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { InteractiveTmuxTerminalManager } from "./tmux-interactive.js";
import { ClaudeStatePollManager, environmentContainerId } from "./tmux-poll.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { classifyCommandFailure } from "@orkestrator/protocol/node/command-failure-reason";

const log = createLogger("tmux");
type TmuxTranscriptResult = ResultOf<typeof claudeTmuxTranscriptCommand>;
type CommandContext = shared.CommandContext;
type AgentToolConnection = shared.AgentToolConnection;
type Environment = shared.Environment;
type JsonRecord = shared.JsonRecord;
type TaskListSnapshot = shared.TaskListSnapshot;
type TmuxAgentObservation = shared.TmuxAgentObservation;
type CommandHandler = shared.CommandHandler;
type RegisterCommand = shared.RegisterCommand;
type ExecOutput = shared.ExecOutput;
type BackendKind = shared.BackendKind;
type RawExecOutput = shared.RawExecOutput;
type TmuxPollSnapshot = shared.TmuxPollSnapshot;
type SessionHookPaths = shared.SessionHookPaths;
type WorkspaceHookPaths = hooks.WorkspaceHookPaths;
type PendingHookEvent = hooks.PendingHookEvent;
type TmuxStatus = hooks.TmuxStatus;
type ProbeExec = hooks.ProbeExec;
type TmuxPaneUpdate = interactive.TmuxPaneUpdate;
type InteractiveTerminalSession = interactive.InteractiveTerminalSession;
type InteractiveTmuxTerminalManagerOptions = interactive.InteractiveTmuxTerminalManagerOptions;
type ClaudeStatePoll = poll.ClaudeStatePoll;
type ClaudeStatePollManagerOptions = poll.ClaudeStatePollManagerOptions;
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
  options: { requireStopped?: boolean } = {},
): Promise<void> {
  await context.runtime.tmux.sessions.installLock(environmentId).runExclusive(async () => {
    context.runtime.tmux.interactiveTerminals.detachEnvironment(environmentId);
    const environment = await context.storage.getEnvironment(environmentId);
    if (environment?.environmentType === "containerized" && environment.status === "stopped") {
      context.runtime.tmux.sessions.removeEnvironment(environmentId);
      return;
    }

    let cleanupComplete = true;
    for (const session of context.runtime.tmux.sessions.environmentSessions(environmentId)) {
      const stopped = await session.stop().catch((error: unknown) => {
        log.warn("cleanup.session-stop-failed", {
          ...classifyCommandFailure(error, { tools: ["tmux"] }),
          error: formatLogError(error),
        });
        return false;
      });
      if (!stopped) cleanupComplete = false;
      else context.runtime.tmux.sessions.removeIfSame(environmentId, session.tabId, session);
    }

    let backend: TmuxBackend;
    try {
      backend = await resolveBackend(environmentId, context);
    } catch (error) {
      if (options.requireStopped || !cleanupComplete) throw error;
      log.debug("cleanup.skipped", () => ({
        ...classifyCommandFailure(error, { tools: ["tmux"] }),
        error: formatLogError(error, { stack: false }),
      }));
      return;
    }

    let survivingEnvironmentIds: string[];
    try {
      survivingEnvironmentIds = (await context.storage.loadEnvironments()).map(
        (remainingEnvironment) => remainingEnvironment.id,
      );
    } catch (error) {
      cleanupComplete = false;
      survivingEnvironmentIds = [];
      log.warn("cleanup.environments-load-failed", { error: formatLogError(error) });
    }

    if (cleanupComplete) {
      const result = await killEnvironmentTmuxSessions(
        backend,
        environmentId,
        survivingEnvironmentIds,
      ).catch((error: unknown) => {
        cleanupComplete = false;
        log.warn("cleanup.kill-failed", {
          ...classifyCommandFailure(error, { tools: ["tmux"] }),
          error: formatLogError(error),
        });
        return { killed: [], complete: false };
      });
      // Silent before to-do 7020: a contested tmux socket or a session that
      // survived kill-session failed the cleanup with nothing in the log.
      if (!result.complete && cleanupComplete) {
        log.warn("cleanup.kill-incomplete", { killed: result.killed.length });
      }
      cleanupComplete = cleanupComplete && result.complete;
    }

    const { workspace } = workspaceAndClaudeHome(backend);
    const hookPaths = workspaceHookPaths(
      path.join(runtimeRootPrefixForContext(context), environmentId),
      workspace,
    );
    await restoreWorkspaceHooks(backend, hookPaths).catch((error: unknown) => {
      cleanupComplete = false;
      log.warn("hooks.uninstall-failed", { error: formatLogError(error) });
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
  registerCommand: CommandRegistrar,
  options: {
    prepareEnvironmentFirstPrompt?: (
      environmentId: string,
      prompt: string,
      context: CommandContext,
    ) => Promise<void>;
    /** Tests step poll ticks and elapse command deadlines; production waits in real time. */
    sessionTiming?: TmuxSessionTimingOptions;
  } = {},
): void {
  const workCommands = new Set([
    "claude_tmux_create_interactive_terminal",
    "claude_tmux_start",
    "claude_tmux_submit",
    "claude_tmux_submit_queued",
    "claude_tmux_send_text",
    "claude_tmux_send_keys",
    "claude_tmux_answer_selection_prompt",
    "claude_tmux_switch_model",
    "claude_tmux_switch_effort",
    "claude_tmux_switch_fast_mode",
    "claude_tmux_switch_plan_mode",
  ]);
  // Every command is defined (plan item 7002), so the wrapper sees decoded
  // arguments: a work command's `environmentId` is already a string.
  const register = wrapRegistrar(registerCommand, (name, handler) =>
    workCommands.has(name)
      ? async (args, context, invocation) => {
          const release = context.runtime.environments.fence.beginAgentWork(
            asString(args.environmentId, "environmentId"),
          );
          try {
            return await handler(args, context, invocation);
          } finally {
            release();
          }
        }
      : handler,
  );
  // Each backend's runtime owns its polls (`TmuxRuntime`); tests build the
  // runtime with a reader and timers instead of a Docker daemon.
  register(reconcileClaudeStatePollingCommand, (_args, context) =>
    context.runtime.tmux.claudeStatePolls.reconcile(context),
  );

  register(
    claudeTmuxStartCommand,
    async (
      {
        tabId,
        environmentId,
        initialPrompt,
        model,
        effort,
        fastMode,
        resumeSessionId,
        replaceExisting,
      },
      context,
    ) => {
      const envId = environmentId;
      const tab = tabId;
      const resumeId = asOptionalString(resumeSessionId);
      const replace = replaceExisting === true;
      const firstPrompt = asOptionalString(initialPrompt)?.trim();
      // Naming persists durable intent only and schedules lifecycle work. Keep
      // it outside the tmux install lock so deletion never takes the lifecycle
      // queue and this mutex in the opposite order.
      if (firstPrompt && !resumeId && options.prepareEnvironmentFirstPrompt) {
        try {
          await options.prepareEnvironmentFirstPrompt(envId, firstPrompt, context);
        } catch (error) {
          // Naming is cosmetic; starting the user's agent is not.
          log.warn("naming.prepare-failed", {
            environmentId: envId,
            error: formatLogError(error, { message: false }),
          });
        }
      }
      return context.runtime.tmux.sessions.installLock(envId).runExclusive(async () => {
        context.runtime.environments.fence.assertNotMoving(envId);
        const environment = await context.storage.getEnvironment(envId);
        if (!environment || environment.deletionRequestedAt) {
          throw new Error(`environment ${envId} is being deleted`);
        }
        if (replace) {
          const existing = context.runtime.tmux.sessions.remove(envId, tab);
          if (existing) await existing.stop();
          else await killOrphanSession(context, envId, tab);
        }

        const session = await getOrCreateSession(
          context,
          envId,
          tab,
          resumeId,
          options.sessionTiming,
        );
        if (firstPrompt) session.claimFirstPromptForNaming();
        await installWorkspaceHooks(session.backend, session.workspaceHookPaths);
        await session.startAfterHooksInstalled(
          context,
          asOptionalString(initialPrompt),
          asOptionalString(model),
          asOptionalString(effort),
          typeof fastMode === "boolean" ? fastMode : undefined,
        );
        await context.runtime.tmux.persistEnvironmentActivity(context, envId);
        return session.status(await session.tmuxAlive().catch(() => false));
      });
    },
    ASYNC_HANDLER,
  );

  register(
    claudeTmuxStopCommand,
    async ({ tabId: tab, environmentId: envId }, context) => {
      await context.runtime.tmux.sessions.installLock(envId).runExclusive(async () => {
        // Start inserts its session before installing hooks and probing the
        // executables. Removing outside this lock lets stop kill "nothing" while
        // that start is paused, after which start can launch an untracked tmux
        // process. Serialize the complete stop transition with start/replace.
        const session = context.runtime.tmux.sessions.get(envId, tab);
        if (!session) {
          await killOrphanSession(context, envId, tab);
        } else {
          if (!(await session.stop())) throw new Error("claude-tmux session stop incomplete");
          context.runtime.tmux.sessions.removeIfSame(envId, tab, session);
        }
        if (session && context.runtime.tmux.sessions.sessionsInEnvironment(envId) === 0) {
          await uninstallWorkspaceHooks(session.backend, session.workspaceHookPaths).catch(
            (error: unknown) => {
              log.warn("hooks.uninstall-failed", { error: formatLogError(error) });
            },
          );
        }
        await context.runtime.tmux.persistEnvironmentActivity(context, envId);
      });
    },
    ASYNC_HANDLER,
  );

  register(
    claudeTmuxInterruptCommand,
    async ({ tabId, environmentId: envId }, context) => {
      await requireSession(context, envId, tabId).interrupt();
      await context.runtime.tmux.persistEnvironmentActivity(context, envId);
    },
    ASYNC_HANDLER,
  );
  // `livenessMaxAgeMs` lets a background reader (mail presence) take the poll
  // loop's own recent `has-session` answer instead of spawning another one.
  register(
    claudeTmuxStatusCommand,
    async ({ tabId, environmentId, livenessMaxAgeMs }, context) => {
      const session = context.runtime.tmux.sessions.get(environmentId, tabId);
      if (!session) return null;
      const recent =
        typeof livenessMaxAgeMs === "number" && Number.isFinite(livenessMaxAgeMs)
          ? session.recentLiveness(livenessMaxAgeMs)
          : undefined;
      return session.status(recent ?? (await session.tmuxAlive().catch(() => false)));
    },
    ASYNC_HANDLER,
  );
  // Stopped history has no poll owner. Keep a small LRU so walking back
  // reconstructs task state once, without retaining every stopped session.
  const historyReaders = new Map<string, TmuxTranscriptReader>();
  // `page` selects a bounded read; `page.before` is the cursor of an earlier
  // page. Without it the caller predates paging and expects the whole file as
  // an array (see the compatibility register in version-compatibility.md).
  register(
    claudeTmuxTranscriptCommand,
    // Transcript records are Claude's JSONL objects (`ClaudeTranscriptLine`):
    // the readers type them `unknown` because they never narrow them.
    async ({ tabId: tab, environmentId: envId, page }, context): Promise<TmuxTranscriptResult> => {
      const session = context.runtime.tmux.sessions.get(envId, tab);
      if (page === undefined) {
        compatibilityPathUsage.record("tmux-transcript.whole-read");
        return (await requireSession(
          context,
          envId,
          tab,
        ).transcriptLines()) as TmuxTranscriptResult;
      }
      const request = page as { before?: unknown; sessionId?: unknown } | null;
      const before = typeof request?.before === "string" ? request.before : undefined;
      if (session) return (await session.transcriptPage(context, before)) as TmuxTranscriptResult;

      // A cursor identifies persisted history independently of the live tmux
      // registry, including after a backend restart. Never accept a path here.
      const sessionId =
        typeof request?.sessionId === "string"
          ? request.sessionId
          : before?.slice(0, before.lastIndexOf(":"));
      if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        throw new Error("tmux transcript session id required");
      }
      const backend = await resolveBackend(envId, context);
      const { workspace, claudeHome } = workspaceAndClaudeHome(backend);
      const file = `${claudeHome}/projects/${encodeCwd(workspace)}/${sessionId}.jsonl`;
      const key = JSON.stringify([
        envId,
        backend.kind,
        backend.containerId,
        backend.cwd,
        file,
        sessionId,
      ]);
      const reader = historyReaders.get(key) ?? new TmuxTranscriptReader(backend, sessionId);
      historyReaders.delete(key);
      historyReaders.set(key, reader);
      while (historyReaders.size > 4) {
        historyReaders.delete(historyReaders.keys().next().value!);
      }
      return (await reader.readPage(file, before, () => undefined)) as TmuxTranscriptResult;
    },
    ASYNC_HANDLER,
  );
  // Authoritative task list for a tmux tab, for callers rehydrating without
  // replaying the whole transcript.
  register(claudeTmuxTasksCommand, ({ tabId, environmentId }, context) =>
    requireSession(context, environmentId, tabId).taskList(),
  );
  register(claudeTmuxPendingHooksCommand, ({ tabId, environmentId }, context) =>
    requireSession(context, environmentId, tabId).pendingHooks(),
  );
  register(
    claudeTmuxSendTextCommand,
    ({ tabId, text, environmentId }, context) =>
      requireSession(context, environmentId, tabId).sendText(text),
    ASYNC_HANDLER,
  );
  register(
    claudeTmuxSendKeysCommand,
    ({ tabId, keys, environmentId }, context) =>
      requireSession(context, environmentId, tabId).sendKeysAndRefresh(asStringArray(keys)),
    ASYNC_HANDLER,
  );
  register(
    claudeTmuxAnswerSelectionPromptCommand,
    (
      {
        tabId,
        environmentId,
        expectedGeneration,
        expectedRevision,
        expectedPromptFingerprint,
        optionIndex,
      },
      context,
    ) =>
      requireSession(context, environmentId, tabId).answerSelectionPrompt({
        expectedGeneration,
        expectedRevision: asNonNegativeInt(expectedRevision, "expectedRevision"),
        expectedPromptFingerprint,
        optionIndex: asNonNegativeInt(optionIndex, "optionIndex"),
      }),
    ASYNC_HANDLER,
  );
  register(
    claudeTmuxSubmitCommand,
    async ({ tabId, text: prompt, environmentId: envId }, context) => {
      const session = requireSession(context, envId, tabId);
      if (
        prompt.trim() &&
        session.claimFirstPromptForNaming() &&
        options.prepareEnvironmentFirstPrompt
      ) {
        try {
          await options.prepareEnvironmentFirstPrompt(envId, prompt, context);
        } catch (error) {
          // Naming is cosmetic; submitting the user's prompt is not.
          log.warn("naming.prepare-failed", {
            environmentId: envId,
            error: formatLogError(error, { message: false }),
          });
        }
      }
      await session.submit(prompt);
      await context.runtime.tmux.persistEnvironmentActivity(context, envId);
    },
    ASYNC_HANDLER,
  );
  register(
    claudeTmuxSubmitQueuedCommand,
    async ({ tabId: tab, text: prompt, environmentId: envId }, context) => {
      // Serialize the final liveness check and terminal side effect with tmux
      // teardown. Deletion writes its tombstone before taking this same lock, so
      // a queued dispatch can never type into a pane after deletion has begun.
      await context.runtime.tmux.sessions.installLock(envId).runExclusive(async () => {
        context.runtime.environments.fence.assertNotMoving(envId);
        const environment = await context.storage.getEnvironment(envId);
        if (!environment || environment.deletionRequestedAt) {
          throw new Error(`environment ${envId} is being deleted`);
        }
        const session = requireSession(context, envId, tab);
        if (prompt.trim()) session.claimFirstPromptForNaming();
        await session.submit(prompt);
        await context.runtime.tmux.persistEnvironmentActivity(context, envId);
      });
    },
    ASYNC_HANDLER,
  );
  register(
    claudeTmuxSwitchModelCommand,
    ({ tabId, model, environmentId }, context) =>
      requireSession(context, environmentId, tabId).switchModel(model),
    ASYNC_HANDLER,
  );
  register(
    claudeTmuxSwitchEffortCommand,
    ({ tabId, effort, environmentId }, context) =>
      requireSession(context, environmentId, tabId).switchEffort(effort),
    ASYNC_HANDLER,
  );
  register(
    claudeTmuxSwitchFastModeCommand,
    ({ tabId, fastMode, environmentId }, context) =>
      requireSession(context, environmentId, tabId).switchFastMode(fastMode, context),
    ASYNC_HANDLER,
  );
  register(
    claudeTmuxSwitchPlanModeCommand,
    ({ tabId, planMode, environmentId }, context) =>
      requireSession(context, environmentId, tabId).switchPlanMode(planMode, context),
    ASYNC_HANDLER,
  );
  register(claudeTmuxResizeCommand, ({ tabId, cols, rows, environmentId }, context) =>
    requireSession(context, environmentId, tabId).resize(
      asPositiveInt(cols, "cols"),
      asPositiveInt(rows, "rows"),
    ),
  );
  register(
    claudeTmuxAnswerPreToolUseCommand,
    ({ tabId, eventId, decision, reason, environmentId }, context) =>
      requireSession(context, environmentId, tabId).answerPreToolUse(
        eventId,
        decision,
        asOptionalString(reason),
      ),
  );
  register(
    claudeTmuxReplyHookCommand,
    ({ tabId, eventKind, eventId, response, environmentId }, context) =>
      requireSession(context, environmentId, tabId).replyHook(eventKind, eventId, response),
  );
  register(
    claudeTmuxHoldHookCommand,
    ({ tabId, eventKind, eventId, held, environmentId }, context) => {
      if (typeof held !== "boolean") throw new Error("held must be a boolean");
      return requireSession(context, environmentId, tabId).holdHook(
        eventKind,
        eventId,
        held,
        context,
      );
    },
  );
  register(
    claudeTmuxListPreviousSessionsCommand,
    async ({ environmentId }, context) => {
      const backend = await resolveBackend(environmentId, context);
      const paths = workspaceAndClaudeHome(backend);
      return listPreviousSessions(backend, paths.claudeHome, paths.workspace);
    },
    ASYNC_HANDLER,
  );
  register(
    claudeTmuxReconcileOrphansCommand,
    async (_args, context) => {
      const now = Date.now();
      const tmux = context.runtime.tmux;
      if (!tmux.beginOrphanSweep(now)) return { reaped: 0, skipped: true };
      const graceMs = 60 * 60 * 1_000;
      const environments = await context.storage.loadEnvironments();
      const paneLayouts = await context.storage.loadPaneLayoutsForReconciliation();
      if (!paneLayouts.available) {
        log.warn("orphans.skipped", { reason: "pane-layouts-unreadable" });
        return { reaped: 0, skipped: true };
      }
      const survivingIds = environments.map((environment) => environment.id);
      tmux.retainQuietEnvironments(new Set(survivingIds));
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
        // A stopped container runs no tmux, and `docker exec` into it only fails.
        if (environment.environmentType !== "local" && environment.status === "stopped") continue;
        let backend: TmuxBackend;
        try {
          backend = await resolveBackend(environment.id, context);
        } catch {
          continue;
        }
        const backendIdentity = `${backend.kind}:${backend.containerId ?? backend.cwd ?? ""}`;
        if (tmux.orphanSweepMaySkip(environment.id, backendIdentity, now)) continue;
        const generation = tmux.sessions.insertGeneration(environment.id);
        const listed = await backend
          .exec(["tmux", "list-sessions", "-F", "#{session_name}"])
          .catch(() => null);
        if (!listed) continue;
        if (
          listed.status !== 0 &&
          !(await confirmTmuxSessionGone(listed.stderr, (args) => backend.exec(args)))
        )
          continue;
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
            tmux.forgetOrphan(key);
            continue;
          }
          if (now - tmux.orphanFirstSeen(key, now) < graceMs) continue;
          const managed = context.runtime.tmux.sessions.findByTmuxName(environment.id, name);
          if (managed) {
            const stopped = await context.runtime.tmux.sessions
              .installLock(environment.id)
              .runExclusive(async () => {
                if (context.runtime.tmux.sessions.findByTmuxName(environment.id, name) !== managed)
                  return false;
                if (!(await managed.stop())) return false;
                return context.runtime.tmux.sessions.removeIfSame(
                  environment.id,
                  managed.tabId,
                  managed,
                );
              });
            if (!stopped) continue;
          } else {
            const killed = await backend.exec(["tmux", "kill-session", "-t", name]);
            if (killed.status !== 0) continue;
          }
          remaining.delete(name);
          tmux.forgetOrphan(key);
          log.info("orphan.reaped", { environmentId: environment.id, session: name });
          reaped += 1;
        }
        if (
          remaining.size === 0 &&
          context.runtime.tmux.sessions.sessionsInEnvironment(environment.id) === 0
        ) {
          const { workspace } = workspaceAndClaudeHome(backend);
          const hookPaths = workspaceHookPaths(
            path.join(runtimeRootPrefixForContext(context), environment.id),
            workspace,
          );
          // Only a verified cleanup ends the retries: a failed restore or a
          // backup or runtime root still present is swept again next minute.
          const uninstalled = await uninstallWorkspaceHooks(backend, hookPaths).catch(() => false);
          if (uninstalled)
            tmux.markOrphanSweepQuiet(environment.id, backendIdentity, generation, now);
        }
      }
      return { reaped, skipped: false };
    },
    ASYNC_HANDLER,
  );
  register(
    claudeTmuxCreateInteractiveTerminalCommand,
    async ({ tabId: tab, environmentId: envId, cols, rows }, context) => {
      const session = requireSession(context, envId, tab);
      if (!(await session.tmuxAlive())) throw new Error("tmux session not running");
      context.runtime.environments.fence.assertNotMoving(envId);
      const environment = await context.storage.getEnvironment(envId);
      if (environment?.environmentType !== "local" && !environmentContainerId(environment)) {
        throw new Error("container environment has no container id");
      }
      return context.runtime.tmux.interactiveTerminals.create(
        session,
        asPositiveInt(cols, "cols"),
        asPositiveInt(rows, "rows"),
      );
    },
    ASYNC_HANDLER,
  );
  register(claudeTmuxStartInteractiveTerminalCommand, ({ terminalSessionId }, context) =>
    context.runtime.tmux.interactiveTerminals.start(terminalSessionId, context),
  );
  register(claudeTmuxWriteInteractiveTerminalCommand, ({ terminalSessionId, data }, context) =>
    context.runtime.tmux.interactiveTerminals.write(terminalSessionId, data, context),
  );
  register(
    claudeTmuxResizeInteractiveTerminalCommand,
    ({ terminalSessionId, cols, rows }, context) =>
      context.runtime.tmux.interactiveTerminals.resize(
        terminalSessionId,
        asPositiveInt(cols, "cols"),
        asPositiveInt(rows, "rows"),
      ),
  );
  register(claudeTmuxDetachInteractiveTerminalCommand, ({ terminalSessionId }, context) => {
    context.runtime.tmux.interactiveTerminals.detach(terminalSessionId);
  });
}

export function requireSession(
  context: CommandContext,
  environmentId: string,
  tabId: string,
): TmuxSession {
  const session = context.runtime.tmux.sessions.get(environmentId, tabId);
  if (!session) throw new Error("tmux session not running");
  return session;
}
