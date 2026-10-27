import * as shared from "./tmux-shared.js";
import * as hooks from "./tmux-hooks.js";
import * as interactive from "./tmux-interactive.js";
import * as poll from "./tmux-poll.js";
import {
  TranscriptTaskTracker,
  asBoolean,
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
import { InteractiveTmuxTerminalManager } from "./tmux-interactive.js";
import { ClaudeStatePollManager, environmentContainerId } from "./tmux-poll.js";
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
        console.warn("[tmux] session stop failed during environment cleanup", error);
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
      console.debug("[tmux] skipping environment tmux cleanup", error);
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
  registerCommand: RegisterCommand,
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
  const register: RegisterCommand = (name, handler) =>
    registerCommand(name, async (args, context) => {
      if (!workCommands.has(name)) return handler(args, context);
      const release = context.runtime.environments.fence.beginAgentWork(
        asString(args.environmentId, "environmentId"),
      );
      try {
        return await handler(args, context);
      } finally {
        release();
      }
    });
  // Each backend's runtime owns its polls (`TmuxRuntime`); tests build the
  // runtime with a reader and timers instead of a Docker daemon.
  register("reconcile_claude_state_polling", (_args, context) =>
    context.runtime.tmux.claudeStatePolls.reconcile(context),
  );

  register(
    "claude_tmux_start",
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
      const envId = asString(environmentId, "environmentId");
      const tab = asString(tabId, "tabId");
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
          console.warn(
            `[tmux] Failed to prepare first-prompt naming for ${envId}:`,
            error instanceof Error ? error.name : "unknown error",
          );
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
  );

  register("claude_tmux_stop", async ({ tabId, environmentId }, context) => {
    const envId = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
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
            console.warn("[tmux] uninstallWorkspaceHooks failed", error);
          },
        );
      }
      await context.runtime.tmux.persistEnvironmentActivity(context, envId);
    });
  });

  register("claude_tmux_interrupt", async ({ tabId, environmentId }, context) => {
    const envId = asString(environmentId, "environmentId");
    await requireSession(context, envId, asString(tabId, "tabId")).interrupt();
    await context.runtime.tmux.persistEnvironmentActivity(context, envId);
  });
  register("claude_tmux_status", async ({ tabId, environmentId }, context) => {
    const session = context.runtime.tmux.sessions.get(
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    );
    return session ? session.status(await session.tmuxAlive().catch(() => false)) : null;
  });
  register("claude_tmux_transcript", ({ tabId, environmentId }, context) =>
    requireSession(
      context,
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    ).transcriptLines(),
  );
  // Authoritative task list for a tmux tab, for callers rehydrating without
  // replaying the whole transcript.
  register("claude_tmux_tasks", ({ tabId, environmentId }, context) =>
    requireSession(
      context,
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    ).taskList(),
  );
  register("claude_tmux_pending_hooks", ({ tabId, environmentId }, context) =>
    requireSession(
      context,
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    ).pendingHooks(),
  );
  register("claude_tmux_send_text", ({ tabId, text, environmentId }, context) =>
    requireSession(
      context,
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    ).sendText(asString(text, "text")),
  );
  register("claude_tmux_send_keys", ({ tabId, keys, environmentId }, context) =>
    requireSession(
      context,
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    ).sendKeysAndRefresh(asStringArray(keys)),
  );
  register(
    "claude_tmux_answer_selection_prompt",
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
      requireSession(
        context,
        asString(environmentId, "environmentId"),
        asString(tabId, "tabId"),
      ).answerSelectionPrompt({
        expectedGeneration: asString(expectedGeneration, "expectedGeneration"),
        expectedRevision: asNonNegativeInt(expectedRevision, "expectedRevision"),
        expectedPromptFingerprint: asString(expectedPromptFingerprint, "expectedPromptFingerprint"),
        optionIndex: asNonNegativeInt(optionIndex, "optionIndex"),
      }),
  );
  register("claude_tmux_submit", async ({ tabId, text, environmentId }, context) => {
    const envId = asString(environmentId, "environmentId");
    const session = requireSession(context, envId, asString(tabId, "tabId"));
    const prompt = asString(text, "text");
    if (
      prompt.trim() &&
      session.claimFirstPromptForNaming() &&
      options.prepareEnvironmentFirstPrompt
    ) {
      try {
        await options.prepareEnvironmentFirstPrompt(envId, prompt, context);
      } catch (error) {
        // Naming is cosmetic; submitting the user's prompt is not.
        console.warn(
          `[tmux] Failed to prepare first-prompt naming for ${envId}:`,
          error instanceof Error ? error.name : "unknown error",
        );
      }
    }
    await session.submit(prompt);
    await context.runtime.tmux.persistEnvironmentActivity(context, envId);
  });
  register("claude_tmux_submit_queued", async ({ tabId, text, environmentId }, context) => {
    const envId = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
    const prompt = asString(text, "text");
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
  });
  register("claude_tmux_switch_model", ({ tabId, model, environmentId }, context) =>
    requireSession(
      context,
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    ).switchModel(asString(model, "model")),
  );
  register("claude_tmux_switch_effort", ({ tabId, effort, environmentId }, context) =>
    requireSession(
      context,
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    ).switchEffort(asString(effort, "effort")),
  );
  register("claude_tmux_switch_fast_mode", ({ tabId, fastMode, environmentId }, context) =>
    requireSession(
      context,
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    ).switchFastMode(asBoolean(fastMode, "fastMode"), context),
  );
  register("claude_tmux_switch_plan_mode", ({ tabId, planMode, environmentId }, context) =>
    requireSession(
      context,
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    ).switchPlanMode(asBoolean(planMode, "planMode"), context),
  );
  register("claude_tmux_resize", ({ tabId, cols, rows, environmentId }, context) =>
    requireSession(
      context,
      asString(environmentId, "environmentId"),
      asString(tabId, "tabId"),
    ).resize(asPositiveInt(cols, "cols"), asPositiveInt(rows, "rows")),
  );
  register(
    "claude_tmux_answer_pre_tool_use",
    ({ tabId, eventId, decision, reason, environmentId }, context) =>
      requireSession(
        context,
        asString(environmentId, "environmentId"),
        asString(tabId, "tabId"),
      ).answerPreToolUse(
        asString(eventId, "eventId"),
        asString(decision, "decision"),
        asOptionalString(reason),
      ),
  );
  register(
    "claude_tmux_reply_hook",
    ({ tabId, eventKind, eventId, response, environmentId }, context) =>
      requireSession(
        context,
        asString(environmentId, "environmentId"),
        asString(tabId, "tabId"),
      ).replyHook(asString(eventKind, "eventKind"), asString(eventId, "eventId"), response),
  );
  register(
    "claude_tmux_hold_hook",
    ({ tabId, eventKind, eventId, held, environmentId }, context) => {
      if (typeof held !== "boolean") throw new Error("held must be a boolean");
      return requireSession(
        context,
        asString(environmentId, "environmentId"),
        asString(tabId, "tabId"),
      ).holdHook(asString(eventKind, "eventKind"), asString(eventId, "eventId"), held, context);
    },
  );
  register("claude_tmux_list_previous_sessions", async ({ environmentId }, context) => {
    const backend = await resolveBackend(asString(environmentId, "environmentId"), context);
    const paths = workspaceAndClaudeHome(backend);
    return listPreviousSessions(backend, paths.claudeHome, paths.workspace);
  });
  register("claude_tmux_reconcile_orphans", async (_args, context) => {
    const now = Date.now();
    const tmux = context.runtime.tmux;
    if (!tmux.beginOrphanSweep(now)) return { reaped: 0, skipped: true };
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
        console.warn(`[tmux] reaped orphaned session ${environment.id}/${name}`);
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
        await uninstallWorkspaceHooks(backend, hookPaths).catch(() => undefined);
      }
    }
    return { reaped, skipped: false };
  });
  register(
    "claude_tmux_create_interactive_terminal",
    async ({ tabId, environmentId, cols, rows }, context) => {
      const envId = asString(environmentId, "environmentId");
      const tab = asString(tabId, "tabId");
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
  );
  register("claude_tmux_start_interactive_terminal", ({ terminalSessionId }, context) =>
    context.runtime.tmux.interactiveTerminals.start(
      asString(terminalSessionId, "terminalSessionId"),
      context,
    ),
  );
  register("claude_tmux_write_interactive_terminal", ({ terminalSessionId, data }, context) =>
    context.runtime.tmux.interactiveTerminals.write(
      asString(terminalSessionId, "terminalSessionId"),
      asString(data, "data"),
      context,
    ),
  );
  register(
    "claude_tmux_resize_interactive_terminal",
    ({ terminalSessionId, cols, rows }, context) =>
      context.runtime.tmux.interactiveTerminals.resize(
        asString(terminalSessionId, "terminalSessionId"),
        asPositiveInt(cols, "cols"),
        asPositiveInt(rows, "rows"),
      ),
  );
  register("claude_tmux_detach_interactive_terminal", ({ terminalSessionId }, context) => {
    context.runtime.tmux.interactiveTerminals.detach(
      asString(terminalSessionId, "terminalSessionId"),
    );
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
