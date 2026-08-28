import * as shared from "./tmux-shared.js";
import * as hooks from "./tmux-hooks.js";
import {
  CLAUDE_TMUX_EVENT,
  COMMAND_AFTER_IDLE_SETTLE_MS,
  COMMAND_IDLE_TIMEOUT_MS,
  COMMAND_NO_HOOK_SETTLE_MS,
  FAST_MODE_POLL_MS,
  FAST_MODE_SWITCH_TIMEOUT_MS,
  FAST_MODE_TMUX_OPTION,
  LIVENESS_CHECK_EVERY_TICKS,
  PERMISSION_MODE_POLL_MS,
  PERMISSION_MODE_SWITCH_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  THINKING_DISPLAY_FLAG,
  THINKING_DISPLAY_VALUE,
  THINKING_MODE_ARGS,
  TMUX_BUSY_OBSERVATION_INTERVAL_MS,
  TMUX_OBSERVATION_INTERVAL_MS,
  TranscriptTaskTracker,
  agentMcpConfigJson,
  agentToolConnectionTarget,
  delay,
  existsSync,
  isMissingTmuxSessionError,
  parseTmuxAgentObservation,
  parseTmuxSelectionPrompt,
  parseTmuxSessionNames,
  path,
  randomUUID,
  runtimeRootPrefixForContext,
  selectReapableTmuxSessions,
  sendInteractiveData,
  shellArg,
  tmuxSelectionPromptFingerprint,
  tmuxSessionName,
} from "./tmux-shared.js";
import { TmuxBackend } from "./tmux-backend.js";
import {
  TMUX_INFO_EVENT_LIMIT,
  TranscriptTail,
  boundedInfoEventMessage,
  drainPending,
  drainTimeouts,
  ensureSessionDirs,
  findTranscriptPath,
  listPendingBlocking,
  localClaudeHome,
  permissionModeFromPane,
  permissionModeFromTranscriptLine,
  preToolUseResponse,
  probeThinkingDisplaySupport,
  replyToHook,
  sessionHookPaths,
  uninstallWorkspaceHooks,
  workspaceHookPaths,
} from "./tmux-hooks.js";
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
export type SessionManagerTmuxLayerTypes = [
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
];
export class TmuxSession {
  readonly sessionId: string;
  readonly tmuxSession: string;
  readonly workspaceHookPaths: WorkspaceHookPaths;
  readonly sessionHookPaths: SessionHookPaths;
  readonly claudeHome: string;
  readonly workspace: string;
  readonly resumed: boolean;
  private firstPromptClaimed: boolean;
  private readonly tmuxCommand = "tmux";
  private readonly claudeCommand: string;
  private readonly startedAtUnix: number;
  private pollLoopRunning = false;
  private stopRequested = false;
  private transcriptPath: string | undefined;
  /**
   * Task list derived from this session's transcript. The backend owns it so
   * the renderer never re-derives it, and so a tab that was not mounted while
   * tasks changed can rehydrate rather than replay.
   */
  private taskTracker = new TranscriptTaskTracker();
  private busy = false;
  private busyStartedAt: number | null = null;
  private readonly infoEvents: TmuxStatus["info_events"] = [];
  /**
   * A Stop hook is a turn boundary even when this backend did not observe the
   * matching UserPromptSubmit (for example, after a backend restart). The
   * durable PR-recheck arm in storage decides whether that boundary matters;
   * this process-local flag only deduplicates duplicate Stop hook files until
   * another prompt starts.
   */
  private stopCompletionObserved = false;
  private completionGeneration = 0;
  private permissionMode = "bypassPermissions";
  private fastMode: boolean | null = null;
  private readonly observationGeneration = randomUUID();
  private observation: TmuxAgentObservation = {
    generation: this.observationGeneration,
    revision: 0,
    observedAt: new Date(0).toISOString(),
    usage: [],
    prompt: null,
  };
  private nextObservationAt = 0;
  /** Force the next scheduled capture to re-emit even if the pane is unchanged. */
  private forceNextObservation = false;
  private observationInFlight: Promise<void> | undefined;
  private readonly inputMutex = new AsyncMutex();

  constructor(
    readonly environmentId: string,
    readonly tabId: string,
    readonly backend: TmuxBackend,
    runtimeRootPrefix: string,
    resumeSessionId?: string,
    claudeCommand?: string,
  ) {
    this.resumed = resumeSessionId !== undefined;
    // A resumed provider session already has authoritative conversation state,
    // even if its transcript has not been discovered by this backend yet.
    this.firstPromptClaimed = this.resumed;
    this.sessionId = resumeSessionId ?? randomUUID();
    this.tmuxSession = tmuxSessionName(environmentId, tabId);
    this.workspace = backend.kind === "local" ? (backend.cwd ?? process.cwd()) : "/workspace";
    this.claudeHome = backend.kind === "local" ? localClaudeHome() : "/home/node/.claude";
    this.workspaceHookPaths = workspaceHookPaths(
      path.join(runtimeRootPrefix, environmentId),
      this.workspace,
    );
    this.sessionHookPaths = sessionHookPaths(this.workspaceHookPaths, this.sessionId);
    this.claudeCommand = claudeCommand ?? "claude";
    this.startedAtUnix = Math.max(0, Math.floor(Date.now() / 1000) - 5);
  }

  status(running: boolean): TmuxStatus {
    return {
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      tmux_session: this.tmuxSession,
      running,
      transcript_path: this.transcriptPath ?? null,
      resumed: this.resumed,
      busy: this.busy,
      busy_started_at: this.busyStartedAt,
      permission_mode: this.permissionMode,
      fast_mode: this.fastMode,
      observation: this.observation,
      info_events: [...this.infoEvents],
    };
  }

  activityState(): "idle" | "working" | "waiting" {
    if (this.busy) return "working";
    return this.observation.prompt ? "waiting" : "idle";
  }

  /** Atomically reserves this fresh session's first user prompt for naming. */
  claimFirstPromptForNaming(): boolean {
    if (this.firstPromptClaimed) return false;
    this.firstPromptClaimed = true;
    return true;
  }

  async discoverTranscriptPath(): Promise<string | undefined> {
    if (this.transcriptPath) return this.transcriptPath;
    const found = await findTranscriptPath(
      this.backend,
      this.claudeHome,
      this.workspace,
      this.sessionId,
      this.startedAtUnix,
    );
    if (found) this.transcriptPath = found;
    return found;
  }

  async transcriptLines(): Promise<unknown[]> {
    const transcriptPath = await this.discoverTranscriptPath();
    if (!transcriptPath) return [];
    const content = (await this.backend.readFile(transcriptPath)) ?? "";

    // Replay task tools from scratch: the file is authoritative for everything
    // written so far, and each historical line must carry the list as it stood
    // *then*, not as it stands now. Overlapping with the live tail is safe —
    // every operation the registry models is idempotent.
    const tracker = new TranscriptTaskTracker();
    const lines: unknown[] = [];
    for (const raw of content.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const line = JSON.parse(trimmed);
        lines.push(this.withTaskSnapshot(line, tracker));
        const permissionMode = permissionModeFromTranscriptLine(line);
        if (permissionMode) this.permissionMode = permissionMode;
      } catch {
        // Continue reading later lines.
      }
    }
    this.taskTracker = tracker;
    return lines;
  }

  /** The session's task list, for callers that want it without the transcript. */
  taskList(): TaskListSnapshot {
    return this.taskTracker.snapshot();
  }

  /**
   * Attach the resulting task list to a line that completed a task tool call,
   * keyed by `tool_use_id` so it reaches that tool's part and no other, and
   * leaving every other line untouched.
   */
  private withTaskSnapshot(line: unknown, tracker: TranscriptTaskTracker): unknown {
    const taskSnapshots = tracker.applyLine(line);
    if (!taskSnapshots || typeof line !== "object" || line === null) return line;
    return { ...(line as Record<string, unknown>), taskSnapshots };
  }

  pendingHooks(): Promise<PendingHookEvent[]> {
    return listPendingBlocking(this.backend, this.sessionHookPaths);
  }

  async startAfterHooksInstalled(
    context: CommandContext,
    initialPrompt: string | undefined,
    model: string | undefined,
    effort: string | undefined,
    fastMode: boolean | undefined,
  ): Promise<void> {
    await ensureSessionDirs(this.backend, this.sessionHookPaths);

    const tmuxProbe = await this.backend.exec(["which", this.tmuxCommand]);
    if (tmuxProbe.status !== 0 || !tmuxProbe.stdout.trim()) {
      throw new Error(
        "tmux is not installed in this environment. For containers, rebuild the base image; for local, install tmux on the host.",
      );
    }

    const claudeCommand = await this.resolveClaudeCommand();
    const claudeProbe = await this.backend.exec([claudeCommand, "--version"]);
    if (claudeProbe.status !== 0) throw new Error("claude CLI not found in this environment.");

    const help = await this.backend.exec([claudeCommand, "--help"]);
    const helpText = `${help.stdout}\n${help.stderr}`;
    if (!helpText.includes("--session-id")) {
      throw new Error(
        "Installed claude CLI does not support --session-id. Upgrade to a newer Claude Code version, or switch to terminal/native mode.",
      );
    }
    if (this.resumed && !helpText.includes("--resume")) {
      throw new Error(
        "Installed claude CLI does not support --resume. Upgrade to a newer Claude Code version to use the resume-session feature.",
      );
    }

    const alive = await this.tmuxAlive();
    const launchedNew = !alive;
    const preserveResumedFastMode = this.resumed && fastMode === undefined;
    const requestedFastMode = fastMode ?? false;
    const launchFastMode = requestedFastMode && helpText.includes("--settings");
    if (launchedNew && requestedFastMode && !launchFastMode) {
      console.warn("[tmux] claude CLI does not support --settings; launching without fast mode");
    }
    if (launchedNew) {
      let agentMcpConfigPath: string | undefined;
      try {
        if (context.agentTools && helpText.includes("--mcp-config")) {
          const environment = await context.storage.getEnvironment(this.environmentId);
          if (environment) {
            const connection = context.agentTools.connection(
              environment.id,
              environment.projectId,
              agentToolConnectionTarget(this.backend.kind),
            );
            agentMcpConfigPath = `${this.workspaceHookPaths.root}/agent-mcp.json`;
            await this.backend.writePrivateFile(agentMcpConfigPath, agentMcpConfigJson(connection));
          }
        }
        const thinkingDisplay = await probeThinkingDisplaySupport(
          (args, stdin, timeoutMs) => this.backend.exec(args, stdin, timeoutMs),
          claudeCommand,
        );
        const claudeCmd = this.claudeLaunchCommand(
          claudeCommand,
          helpText,
          model,
          effort,
          launchFastMode,
          thinkingDisplay,
          agentMcpConfigPath,
        );
        const runtimePrefix =
          this.backend.kind === "container"
            ? ". /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true; " +
              "orkestrator_source_runtime_env 2>/dev/null || true; "
            : "";
        const wrapped = `${runtimePrefix}${claudeCmd}; echo '[claude exited]'; exec bash`;
        const out = await this.backend.exec([
          this.tmuxCommand,
          "new-session",
          "-d",
          "-s",
          this.tmuxSession,
          "-x",
          "200",
          "-y",
          "50",
          "sh",
          "-c",
          wrapped,
        ]);
        if (out.status !== 0) throw new Error(`tmux new-session failed: ${out.stderr}`);
      } catch (error) {
        if (agentMcpConfigPath) {
          await this.backend.removeFile(agentMcpConfigPath).catch(() => undefined);
        }
        throw error;
      }
      await this.inputMutex.runExclusive(async () => {
        if (preserveResumedFastMode) {
          // A resume with no explicit one-shot choice must let Claude restore
          // the conversation's own speed instead of labelling it Normal before
          // the resumed process can report its state.
          this.fastMode = null;
          return;
        }
        this.fastMode = launchFastMode;
        await this.persistFastModeOptionWithRetry(launchFastMode).catch((error) => {
          console.warn("[tmux] failed to persist launch fast mode", error);
        });
      });
    } else {
      await this.inputMutex.runExclusive(async () => {
        const persisted = await this.readFastModeOption();
        if (persisted !== null) {
          this.fastMode = persisted;
          return;
        }
        const snapshot = await this.capturePane().catch(() => "");
        const recovered = fastModeFromPane(snapshot);
        if (recovered !== undefined) this.fastMode = recovered;
        // If this process launched the session but the original metadata write
        // failed, its in-memory value is still authoritative enough to repair
        // the missing tmux option on a later attach. A fresh backend process
        // starts at null and therefore never invents a value here.
        if (this.fastMode !== null) {
          await this.persistFastModeOptionWithRetry(this.fastMode).catch((error) => {
            console.warn("[tmux] failed to repair reattached fast mode metadata", error);
          });
        }
      });
    }

    this.spawnPollLoop(context);
    context.emit(CLAUDE_TMUX_EVENT, {
      kind: "started",
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      observation_generation: this.observationGeneration,
      resumed: this.resumed,
      fast_mode: this.fastMode,
    });

    // A second client attaching to this stable tab must not submit the
    // bootstrap again. The backend call that actually launched tmux owns it.
    if (launchedNew && initialPrompt?.trim()) {
      void this.sendInitialPromptWhenReady(initialPrompt, launchedNew)
        .then(() => {
          context.emit(CLAUDE_TMUX_EVENT, {
            kind: "initial-prompt-sent",
            tab_id: this.tabId,
            environment_id: this.environmentId,
            session_id: this.sessionId,
          });
        })
        .catch((error) => {
          context.emit(CLAUDE_TMUX_EVENT, {
            kind: "warning",
            tab_id: this.tabId,
            environment_id: this.environmentId,
            message: `Failed to send initial prompt: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
    }
  }

  private async resolveClaudeCommand(): Promise<string> {
    if (this.claudeCommand.includes("/")) {
      const probe = await this.backend.exec(["test", "-x", this.claudeCommand]);
      if (probe.status === 0) return this.claudeCommand;
    }
    const which = await this.backend.exec(["which", "claude"]);
    const resolved = which.stdout.trim().split("\n")[0];
    return which.status === 0 && resolved ? resolved : this.claudeCommand;
  }

  private claudeLaunchCommand(
    claudeCommand: string,
    helpText: string,
    model: string | undefined,
    effort: string | undefined,
    fastMode: boolean,
    supportsThinkingDisplay: boolean,
    agentMcpConfigPath?: string,
  ): string {
    let command = shellArg(claudeCommand);
    if (model?.trim()) command += ` --model ${shellArg(model)}`;
    if (effort?.trim()) {
      if (helpText.includes("--effort")) {
        command += ` --effort ${shellArg(effort)}`;
      } else {
        console.warn("[tmux] claude CLI does not support --effort; launching without it");
      }
    }
    if (fastMode) {
      command += ` --settings ${shellArg(JSON.stringify({ fastMode: true }))}`;
    }
    // Opus 4.7 and newer default adaptive thinking display to "omitted", which
    // writes thinking blocks to the transcript with an empty `thinking` string
    // (signature only). Native Mode opts back into "summarized" through the
    // Agent SDK; do the same here so the tmux chat tab renders reasoning too.
    if (supportsThinkingDisplay) {
      command += ` ${THINKING_MODE_ARGS.join(" ")} ${THINKING_DISPLAY_FLAG} ${THINKING_DISPLAY_VALUE}`;
    }
    if (agentMcpConfigPath) {
      command += ` --mcp-config ${shellArg(agentMcpConfigPath)}`;
    }
    command += " --dangerously-skip-permissions";
    command += this.resumed ? ` --resume ${this.sessionId}` : ` --session-id ${this.sessionId}`;
    return command;
  }

  private async sendInitialPromptWhenReady(prompt: string, launchedNew: boolean): Promise<void> {
    if (launchedNew) await delay(800);
    await this.waitForTuiInputReady();
    await this.submit(prompt);
    // Hooks fire asynchronously; set busy immediately so status() is accurate before the hook lands.
    this.setBusyState(true);
  }

  private setBusyState(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.busyStartedAt = busy ? Date.now() : null;
  }

  private async waitForTuiInputReady(): Promise<void> {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      if (!(await this.tmuxAlive().catch(() => false))) {
        throw new Error("tmux session stopped before Claude was ready");
      }
      const snapshot = await this.capturePane().catch(() => "");
      if (paneHasClaudeExited(snapshot))
        throw new Error("Claude exited before the initial prompt was sent");
      if (!paneHasSelectionPrompt(snapshot)) return;
      await delay(500);
    }
    throw new Error("timed out waiting for Claude to leave its startup prompt");
  }

  private spawnPollLoop(context: CommandContext): void {
    if (this.pollLoopRunning) return;
    this.pollLoopRunning = true;
    this.stopRequested = false;
    const emittedBlockingIds = new Set<string>();
    let tail: TranscriptTail | undefined;

    let tick = 0;

    void (async () => {
      try {
        while (!this.stopRequested) {
          await delay(POLL_INTERVAL_MS);
          if (this.stopRequested) break;
          tick += 1;

          // Discovered before the snapshot so the same round trip can carry the
          // transcript size.
          if (!tail) {
            try {
              const transcriptPath = await this.discoverTranscriptPath();
              if (transcriptPath) tail = new TranscriptTail(transcriptPath);
            } catch (error) {
              console.warn("[tmux] transcript discovery failed", error);
            }
          }

          let snapshot: TmuxPollSnapshot | undefined;
          try {
            snapshot = await this.backend.pollSnapshot(this.sessionHookPaths, tail?.filePath);
          } catch (error) {
            console.warn("[tmux] poll snapshot failed", error);
          }

          if (snapshot) {
            try {
              const events = await drainPending(
                this.backend,
                this.sessionHookPaths,
                snapshot.pending,
                emittedBlockingIds,
              );
              for (const event of events) this.emitHook(context, event);
            } catch (error) {
              console.warn("[tmux] drainPending failed", error);
            }

            try {
              const timeouts = await drainTimeouts(
                this.backend,
                this.sessionHookPaths,
                snapshot.timeouts,
              );
              for (const timeout of timeouts) {
                emittedBlockingIds.delete(timeout.id);
                context.emit(CLAUDE_TMUX_EVENT, {
                  kind: "hook-timed-out",
                  tab_id: this.tabId,
                  environment_id: this.environmentId,
                  session_id: this.sessionId,
                  event_kind: timeout.kind,
                  event_id: timeout.id,
                });
              }
            } catch (error) {
              console.warn("[tmux] drainTimeouts failed", error);
            }

            if (tail) {
              try {
                const lines = await tail.readNew(this.backend, snapshot.transcriptSize);
                for (const line of lines) {
                  const permissionMode = permissionModeFromTranscriptLine(line);
                  if (permissionMode) this.setPermissionMode(permissionMode, context);
                  context.emit(CLAUDE_TMUX_EVENT, {
                    kind: "transcript-line",
                    tab_id: this.tabId,
                    environment_id: this.environmentId,
                    session_id: this.sessionId,
                    line: this.withTaskSnapshot(line, this.taskTracker),
                  });
                }
              } catch (error) {
                console.warn("[tmux] transcript tail failed", error);
              }
            }
          }

          if (Date.now() >= this.nextObservationAt && !this.observationInFlight) {
            this.nextObservationAt =
              Date.now() +
              (this.busy ? TMUX_BUSY_OBSERVATION_INTERVAL_MS : TMUX_OBSERVATION_INTERVAL_MS);
            const forceEmit = this.forceNextObservation;
            this.forceNextObservation = false;
            const observation = this.refreshObservation(context, forceEmit)
              .catch((error) => {
                if (forceEmit) {
                  this.forceNextObservation = true;
                  this.nextObservationAt = 0;
                }
                // Pane contents are sensitive. Report only the error class.
                console.warn(
                  "[tmux] pane observation failed",
                  error instanceof Error ? error.name : "unknown error",
                );
              })
              .finally(() => {
                if (this.observationInFlight === observation) {
                  this.observationInFlight = undefined;
                }
              });
            this.observationInFlight = observation;
          }

          // Liveness is a whole extra process spawn (a `docker exec` in
          // container mode) and a session that ends stays ended, so it is
          // checked on a slower cadence than the hook and transcript reads.
          if (tick % LIVENESS_CHECK_EVERY_TICKS !== 0) continue;
          if (!(await this.tmuxAlive().catch(() => false))) {
            let removed = false;
            await tmuxManager.installLock(this.environmentId).runExclusive(async () => {
              // A replace/stop may have won while the liveness process was in
              // flight. It owns the transition and any newer session under the
              // same tab key; never emit a stale stopped frame for that case.
              if (this.stopRequested) return;
              if (await this.tmuxAlive().catch(() => false)) return;
              removed = tmuxManager.removeIfSame(this.environmentId, this.tabId, this);
              if (!removed) return;
              this.setBusyState(false);
              await this.backend.removeDir(this.sessionHookPaths.sessionDir).catch(() => undefined);
              if (tmuxManager.sessionsInEnvironment(this.environmentId) === 0) {
                await uninstallWorkspaceHooks(this.backend, this.workspaceHookPaths).catch(
                  (error) => {
                    console.warn("[tmux] uninstallWorkspaceHooks failed", error);
                  },
                );
              }
            });
            if (!removed) {
              if (this.stopRequested) break;
              continue;
            }
            context.emit(CLAUDE_TMUX_EVENT, {
              kind: "stopped",
              tab_id: this.tabId,
              environment_id: this.environmentId,
            });
            await persistTmuxEnvironmentActivity(context, this.environmentId);
            break;
          }
        }
      } finally {
        this.pollLoopRunning = false;
      }
    })();
  }

  private async refreshObservation(context: CommandContext, forceEmit = false): Promise<void> {
    const pane = await this.capturePane();
    const next = {
      ...parseTmuxAgentObservation(pane, this.observation.revision + 1, new Date().toISOString()),
      generation: this.observationGeneration,
    };
    const promptChanged = JSON.stringify(next.prompt) !== JSON.stringify(this.observation.prompt);
    const usageChanged = JSON.stringify(next.usage) !== JSON.stringify(this.observation.usage);
    if (!forceEmit && !promptChanged && !usageChanged) return;

    const previousPrompt = this.observation.prompt;
    this.observation = next;
    context.emit(CLAUDE_TMUX_EVENT, {
      kind: "observation",
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      observation: next,
    });
    if (usageChanged) {
      context.emit("tmux-agent-usage", {
        tab_id: this.tabId,
        environment_id: this.environmentId,
        session_id: this.sessionId,
        revision: next.revision,
        observed_at: next.observedAt,
        usage: next.usage,
      });
    }
    if (promptChanged) {
      context.emit(next.prompt ? "tmux-prompt-detected" : "tmux-prompt-cleared", {
        tab_id: this.tabId,
        environment_id: this.environmentId,
        session_id: this.sessionId,
        revision: next.revision,
        observed_at: next.observedAt,
        ...(next.prompt ? { prompt: next.prompt } : { previous_prompt: previousPrompt }),
      });
    }
    await persistTmuxEnvironmentActivity(context, this.environmentId);
  }

  private emitHook(context: CommandContext, event: PendingHookEvent): void {
    this.updateBusyFromHookKind(event.kind, context);
    if (event.kind === "Stop") this.scheduleCompletionNotification(context);
    let emittedPayload = event.payload;
    if (event.kind === "Notification" || event.kind === "Stop") {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : undefined;
      const rawMessage =
        typeof payload?.message === "string"
          ? payload.message
          : event.kind === "Stop"
            ? "Claude finished responding"
            : "Claude sent a notification";
      const message = boundedInfoEventMessage(rawMessage);
      // Bound the message the subscribers get too. Retaining a trimmed copy
      // while broadcasting the original would move the cost rather than remove
      // it: the payload is fanned out to every SSE listener.
      if (payload && typeof payload.message === "string") {
        emittedPayload = { ...payload, message };
      }
      const duplicateIndex = this.infoEvents.findIndex(
        (entry) => entry.id === event.id && entry.kind === event.kind,
      );
      if (duplicateIndex >= 0) this.infoEvents.splice(duplicateIndex, 1);
      this.infoEvents.push({
        id: event.id,
        kind: event.kind,
        message,
        receivedAt: new Date(event.requestedAt ?? Date.now()).toISOString(),
      });
      if (this.infoEvents.length > TMUX_INFO_EVENT_LIMIT) {
        this.infoEvents.splice(0, this.infoEvents.length - TMUX_INFO_EVENT_LIMIT);
      }
    }
    context.emit(CLAUDE_TMUX_EVENT, {
      kind: "hook",
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      event_id: event.id,
      event_kind: event.kind,
      payload: emittedPayload,
      requested_at: event.requestedAt,
      expires_at: event.expiresAt,
    });
  }

  private updateBusyFromHookKind(kind: string, context: CommandContext): void {
    const previous = this.busy;
    if (kind === "UserPromptSubmit") {
      this.setBusyState(true);
      this.completionGeneration += 1;
      this.stopCompletionObserved = false;
    }
    if (kind === "Stop") this.setBusyState(false);
    if (previous !== this.busy) {
      // Do not make the stdout/hook loop wait for storage; the next observation
      // also reconciles this source if the write fails.
      void persistTmuxEnvironmentActivity(context, this.environmentId);
    }
  }

  private scheduleCompletionNotification(context: CommandContext): void {
    if (this.stopCompletionObserved) return;
    this.stopCompletionObserved = true;
    const generation = this.completionGeneration;

    const notification = (async () => {
      // Storage is authoritative. In particular, a Stop seen immediately after
      // re-attaching to an existing tmux session is a completion only when the
      // durable Resolve-conflicts intent is still armed. Conversely an
      // unarmed startup Stop must not manufacture work for the PR monitor.
      const environment = await context.storage.getEnvironment(this.environmentId);
      if (!environment?.prRecheckAfterAgentCompletionArmedAt) return;
      await context.notifyAgentTurnCompleted?.(this.environmentId);
    })();
    void notification.catch((error) => {
      // Keep the durable arm intact and permit a later Stop to retry delivery.
      // The hook has already been emitted to the renderer, so this failure is
      // deliberately confined to the reconciliation side effect.
      if (this.completionGeneration === generation) {
        this.stopCompletionObserved = false;
      }
      console.warn(
        `[tmux] Failed to schedule PR refresh after agent completion for ${this.environmentId}:`,
        error instanceof Error ? error.message : error,
      );
    });
  }

  async tmuxAlive(): Promise<boolean> {
    const out = await this.backend.exec([this.tmuxCommand, "has-session", "-t", this.tmuxSession]);
    return out.status === 0;
  }

  private async sendTextUnlocked(text: string): Promise<void> {
    if (!text) return;
    const bufferName = `claude-tmux-input-${this.tmuxSession}`;
    const load = await this.backend.exec(
      [this.tmuxCommand, "load-buffer", "-b", bufferName, "-"],
      text,
    );
    if (load.status !== 0) throw new Error(load.stderr || "tmux load-buffer failed");
    const paste = await this.backend.exec([
      this.tmuxCommand,
      "paste-buffer",
      "-p",
      "-d",
      "-b",
      bufferName,
      "-t",
      this.tmuxSession,
    ]);
    if (paste.status !== 0) throw new Error(paste.stderr || "tmux paste-buffer failed");
  }

  async sendText(text: string): Promise<void> {
    await this.inputMutex.runExclusive(() => this.sendTextUnlocked(text));
  }

  /**
   * Schedule an authoritative pane read immediately after input. The renderer
   * may hide an answered prompt optimistically, but this forced emission makes
   * the backend restore it if Claude did not actually accept the keys.
   */
  async sendKeysAndRefresh(keys: string[]): Promise<void> {
    await this.sendKeys(keys);
    this.forceNextObservation = true;
    this.nextObservationAt = 0;
  }

  private async sendLiteralUnlocked(text: string): Promise<void> {
    if (!text) return;
    const out = await this.backend.exec([
      this.tmuxCommand,
      "send-keys",
      "-t",
      this.tmuxSession,
      "-l",
      text,
    ]);
    if (out.status !== 0) throw new Error(out.stderr || "tmux send-keys failed");
  }

  async sendLiteral(text: string): Promise<void> {
    await this.inputMutex.runExclusive(() => this.sendLiteralUnlocked(text));
  }

  private async sendKeysUnlocked(keys: string[]): Promise<void> {
    const out = await this.backend.exec([
      this.tmuxCommand,
      "send-keys",
      "-t",
      this.tmuxSession,
      "--",
      ...keys,
    ]);
    if (out.status !== 0) throw new Error(out.stderr || "tmux send-keys failed");
  }

  async sendKeys(keys: string[]): Promise<void> {
    await this.inputMutex.runExclusive(() => this.sendKeysUnlocked(keys));
  }

  async answerSelectionPrompt(input: {
    expectedGeneration: string;
    expectedRevision: number;
    expectedPromptFingerprint: string;
    optionIndex: number;
  }): Promise<void> {
    await this.inputMutex.runExclusive(async () => {
      const markPromptForRefresh = (): void => {
        this.forceNextObservation = true;
        this.nextObservationAt = 0;
      };
      const observedPrompt = this.observation.prompt;
      if (
        input.expectedGeneration !== this.observationGeneration ||
        input.expectedRevision !== this.observation.revision ||
        !observedPrompt ||
        tmuxSelectionPromptFingerprint(observedPrompt) !== input.expectedPromptFingerprint
      ) {
        markPromptForRefresh();
        throw new Error("Selection prompt is no longer current");
      }

      // The observation can become stale between its SSE emission and this
      // command. Re-read the pane while holding the same mutex as every input
      // path so validation and key delivery form one serialized operation.
      const currentPrompt = parseTmuxSelectionPrompt(await this.capturePane());
      if (
        !currentPrompt ||
        tmuxSelectionPromptFingerprint(currentPrompt) !== input.expectedPromptFingerprint
      ) {
        markPromptForRefresh();
        throw new Error("Selection prompt is no longer current");
      }
      const option = currentPrompt.options[input.optionIndex];
      if (!option) {
        markPromptForRefresh();
        throw new Error("Selection prompt is no longer current");
      }

      let keys: string[];
      if (currentPrompt.inputMode === "number") {
        keys = option.number.toString().split("");
      } else if (currentPrompt.selectedOptionIndex === null) {
        keys = [
          ...Array.from({ length: currentPrompt.options.length }, () => "Up"),
          ...Array.from({ length: input.optionIndex }, () => "Down"),
          "Enter",
        ];
      } else {
        const delta = input.optionIndex - currentPrompt.selectedOptionIndex;
        const navKey = delta > 0 ? "Down" : "Up";
        keys = [...Array.from({ length: Math.abs(delta) }, () => navKey), "Enter"];
      }
      await this.sendKeysUnlocked(keys);
      this.forceNextObservation = true;
      this.nextObservationAt = 0;
    });
  }

  private async submitUnlocked(text: string): Promise<void> {
    if (text) {
      await this.sendTextUnlocked(text);
      await delay(250);
    }
    await this.sendKeysUnlocked(["Enter"]);
  }

  async submit(text: string): Promise<void> {
    await this.inputMutex.runExclusive(async () => {
      await this.submitUnlocked(text);
      if (text.trim()) {
        // Hooks arrive asynchronously. Mark a submitted user turn busy before
        // releasing the input lock so a queued mode switch cannot run in the
        // gap between Enter and the UserPromptSubmit hook.
        this.setBusyState(true);
      }
    });
  }

  async switchModel(model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed) throw new Error("model id cannot be empty");
    await this.inputMutex.runExclusive(async () => {
      await this.submitUnlocked(`/model ${trimmed}`);
      await this.waitForCommandIdle();
    });
  }

  async switchEffort(effort: string): Promise<void> {
    const trimmed = effort.trim();
    if (!trimmed) throw new Error("effort level cannot be empty");
    await this.inputMutex.runExclusive(async () => {
      await this.submitUnlocked(`/effort ${trimmed}`);
      await this.waitForCommandIdle();
    });
  }

  async switchFastMode(fastMode: boolean, context: CommandContext): Promise<void> {
    await this.inputMutex.runExclusive(async () => {
      if (this.busy) throw new Error("Cannot switch Claude fast mode while a turn is running");
      const before = await this.capturePane();
      if (paneHasClaudeExited(before)) {
        throw new Error("Claude exited before fast mode could be changed");
      }
      if (paneHasSelectionPrompt(before)) {
        throw new Error("Finish the active Claude prompt before changing fast mode");
      }
      const recovered = fastModeFromPane(before);
      if (recovered !== undefined) {
        const recoveredChanged = this.fastMode !== recovered;
        this.fastMode = recovered;
        if (recoveredChanged) this.emitFastModeChanged(recovered, context);
        await this.persistFastModeOption(recovered);
        if (recovered === fastMode) return;
      }
      const command = `/fast ${fastMode ? "on" : "off"}`;
      await this.submitUnlocked(command);
      await this.waitForPaneFastMode(fastMode, before, command);
      this.fastMode = fastMode;
      this.emitFastModeChanged(fastMode, context);
      try {
        await this.persistFastModeOption(fastMode);
      } catch (error) {
        throw new Error(
          `Fast mode changed but its restart metadata could not be saved: ${String(error)}`,
        );
      }
    });
  }

  private emitFastModeChanged(fastMode: boolean, context: CommandContext): void {
    context.emit(CLAUDE_TMUX_EVENT, {
      kind: "fast-mode-changed",
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      fast_mode: fastMode,
    });
  }

  private async readFastModeOption(): Promise<boolean | null> {
    const result = await this.backend.exec([
      this.tmuxCommand,
      "show-options",
      "-qv",
      "-t",
      this.tmuxSession,
      FAST_MODE_TMUX_OPTION,
    ]);
    if (result.status !== 0) return null;
    const value = result.stdout.trim();
    if (value === "1") return true;
    if (value === "0") return false;
    return null;
  }

  private async persistFastModeOption(fastMode: boolean): Promise<void> {
    const result = await this.backend.exec([
      this.tmuxCommand,
      "set-option",
      "-t",
      this.tmuxSession,
      FAST_MODE_TMUX_OPTION,
      fastMode ? "1" : "0",
    ]);
    if (result.status !== 0) {
      throw new Error(result.stderr || "tmux fast-mode metadata write failed");
    }
  }

  private async persistFastModeOptionWithRetry(fastMode: boolean): Promise<void> {
    try {
      await this.persistFastModeOption(fastMode);
    } catch {
      await delay(FAST_MODE_POLL_MS);
      await this.persistFastModeOption(fastMode);
    }
  }

  private async waitForPaneFastMode(
    target: boolean,
    initialSnapshot: string,
    command: string,
  ): Promise<void> {
    const deadline = Date.now() + FAST_MODE_SWITCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const snapshot = await this.capturePane();
      if (snapshot === initialSnapshot) {
        await delay(FAST_MODE_POLL_MS);
        continue;
      }
      if (paneHasClaudeExited(snapshot)) {
        throw new Error("Claude exited before fast mode could be changed");
      }
      if (paneHasSelectionPrompt(snapshot)) {
        throw new Error("Finish the active Claude prompt before changing fast mode");
      }
      const response = paneOutputAfterCommand(initialSnapshot, snapshot, command);
      const rejection = fastModeRejectionFromPane(response);
      if (rejection) throw new Error(rejection);
      const observed = fastModeFromPane(response);
      if (observed === target) return;
      await delay(FAST_MODE_POLL_MS);
    }
    throw new Error(`Claude did not confirm fast mode ${target ? "on" : "off"}`);
  }

  async switchPlanMode(planMode: boolean, context: CommandContext): Promise<string> {
    return await this.inputMutex.runExclusive(async () => {
      if (this.busy) throw new Error("Cannot switch Claude mode while a turn is running");
      const targetMode = planMode ? "plan" : "bypassPermissions";
      let observedMode = await this.capturePanePermissionMode();
      if (observedMode) this.setPermissionMode(observedMode, context);
      if (observedMode === targetMode) return targetMode;

      // `/plan` enters Plan Mode directly. This avoids cycling forward from
      // bypassPermissions into Auto Mode, which can open a first-use opt-in
      // prompt and leave the backend unable to complete the transition.
      if (observedMode !== "plan") {
        await this.submitUnlocked("/plan");
        observedMode = await this.waitForPanePermissionMode("plan");
        this.setPermissionMode(observedMode, context);
      }

      if (targetMode === "plan") return targetMode;

      // Bypass is the first optional mode after Plan in Claude's documented
      // Shift+Tab cycle because tmux sessions launch with bypass enabled.
      await this.sendKeysUnlocked(["BTab"]);
      observedMode = await this.waitForPanePermissionMode("bypassPermissions");
      this.setPermissionMode(observedMode, context);
      return targetMode;
    });
  }

  private async capturePanePermissionMode(): Promise<string | undefined> {
    const snapshot = await this.capturePane();
    if (paneHasClaudeExited(snapshot))
      throw new Error("Claude exited before its mode could be changed");
    if (paneHasSelectionPrompt(snapshot)) {
      throw new Error("Finish the active Claude prompt before changing modes");
    }
    return permissionModeFromPane(snapshot);
  }

  private async waitForPanePermissionMode(targetMode: string): Promise<string> {
    const deadline = Date.now() + PERMISSION_MODE_SWITCH_TIMEOUT_MS;
    let lastObservedMode: string | undefined;
    while (Date.now() < deadline) {
      const observedMode = await this.capturePanePermissionMode();
      if (observedMode) {
        lastObservedMode = observedMode;
        if (observedMode === targetMode) return observedMode;
      }
      await delay(PERMISSION_MODE_POLL_MS);
    }
    const observed = lastObservedMode ? `; observed ${lastObservedMode}` : "";
    throw new Error(`Claude did not enter ${targetMode}${observed}`);
  }

  private setPermissionMode(permissionMode: string, context: CommandContext): void {
    if (permissionMode === this.permissionMode) return;
    this.permissionMode = permissionMode;
    context.emit(CLAUDE_TMUX_EVENT, {
      kind: "permission-mode-changed",
      tab_id: this.tabId,
      environment_id: this.environmentId,
      session_id: this.sessionId,
      permission_mode: permissionMode,
    });
  }

  private async waitForCommandIdle(): Promise<void> {
    const started = Date.now();
    const deadline = started + COMMAND_IDLE_TIMEOUT_MS;
    const noHookDeadline = started + COMMAND_NO_HOOK_SETTLE_MS;
    let sawBusy = this.busy;
    while (Date.now() < deadline) {
      if (this.busy) {
        sawBusy = true;
      } else if (sawBusy) {
        await delay(COMMAND_AFTER_IDLE_SETTLE_MS);
        return;
      } else if (Date.now() >= noHookDeadline) {
        return;
      }
      await delay(50);
    }
    console.warn("[tmux] timed out waiting for Claude slash command to settle", this.tmuxSession);
  }

  async interrupt(): Promise<void> {
    await this.inputMutex.runExclusive(async () => {
      await this.sendKeysUnlocked(["Escape"]);
      this.setBusyState(false);
    });
  }

  async writeInteractive(data: string): Promise<void> {
    await this.inputMutex.runExclusive(() =>
      sendInteractiveData(
        data,
        (literal) => this.sendLiteralUnlocked(literal),
        (keys) => this.sendKeysUnlocked(keys),
      ),
    );
  }

  async capturePane(options: { ansi?: boolean; joinWrapped?: boolean } = {}): Promise<string> {
    const args = [this.tmuxCommand, "capture-pane", "-t", this.tmuxSession, "-p"];
    if (options.ansi) args.push("-e");
    if (options.joinWrapped ?? true) args.push("-J");
    const out = await this.backend.exec(args);
    if (out.status !== 0) throw new Error(out.stderr || "tmux capture-pane failed");
    return out.stdout;
  }

  async resize(cols: number, rows: number): Promise<void> {
    const out = await this.backend.exec([
      this.tmuxCommand,
      "resize-window",
      "-t",
      this.tmuxSession,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
    if (out.status !== 0) throw new Error(out.stderr || "tmux resize-window failed");
  }

  async replyHook(kind: string, id: string, response: unknown): Promise<void> {
    await replyToHook(this.backend, this.sessionHookPaths, kind, id, response);
  }

  async answerPreToolUse(id: string, decision: string, reason?: string): Promise<void> {
    await this.replyHook("PreToolUse", id, preToolUseResponse(decision, reason));
  }

  async stop(): Promise<boolean> {
    const result = await this.backend
      .exec([this.tmuxCommand, "kill-session", "-t", this.tmuxSession])
      .catch(() => null);
    const stopped = Boolean(
      result && (result.status === 0 || isMissingTmuxSessionError(result.stderr)),
    );
    if (!stopped) return false;
    this.stopRequested = true;
    await this.backend.removeDir(this.sessionHookPaths.sessionDir).catch(() => undefined);
    return true;
  }
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

/** Limit acknowledgement parsing to rows produced after this command. */
export function paneOutputAfterCommand(
  initialSnapshot: string,
  snapshot: string,
  command: string,
): string {
  const before = stripAnsi(initialSnapshot);
  const current = stripAnsi(snapshot);
  const commandIndex = current.lastIndexOf(command);
  const beforeCommandCount = before.split(command).length - 1;
  const currentCommandCount = current.split(command).length - 1;
  if (commandIndex >= 0 && currentCommandCount > beforeCommandCount) {
    return current.slice(commandIndex + command.length);
  }

  const beforeLines = before.split("\n");
  const currentLines = current.split("\n");
  const maxOverlap = Math.min(beforeLines.length, currentLines.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (beforeLines[beforeLines.length - overlap + index] !== currentLines[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return currentLines.slice(overlap).join("\n");
  }
  return current;
}

/** Return the newest explicit fast-mode acknowledgement visible in the pane. */
export function fastModeFromPane(snapshot: string): boolean | undefined {
  const lines = stripAnsi(snapshot).split("\n").reverse();
  for (const line of lines) {
    const match = line.match(/\bFast mode\s+(ON|OFF)\b/i);
    if (match) return match[1]!.toUpperCase() === "ON";
  }
  return undefined;
}

/** Return an actionable error for a visible `/fast` rejection. */
export function fastModeRejectionFromPane(snapshot: string): string | undefined {
  const plain = stripAnsi(snapshot);
  const rejection = plain
    .split("\n")
    .reverse()
    .find(
      (line) =>
        /fast mode(?: is)?.*(?:not available|unavailable|not supported)/i.test(line) ||
        /fast mode requires (?:an? )?(?:eligible|supported|paid|subscription|plan|account|model|Claude Code)/i.test(
          line,
        ) ||
        /unknown (?:command|argument).*\/fast/i.test(line) ||
        /\/fast.*requires Claude Code/i.test(line),
    );
  return rejection?.trim() || undefined;
}

export function paneHasSelectionPrompt(snapshot: string): boolean {
  const plain = stripAnsi(snapshot);
  const lower = plain.toLowerCase();
  if (!lower.includes("esc to cancel") || !lower.includes("enter to")) return false;
  return plain.split("\n").some((line) => {
    const trimmed = line.trimStart().replace(/^[>›❯▸➜→]\s*/, "");
    const match = /^(\d+)\. /.exec(trimmed);
    return match !== null;
  });
}

export function paneHasClaudeExited(snapshot: string): boolean {
  return stripAnsi(snapshot).includes("[claude exited]");
}

export class AsyncMutex {
  private chain = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.chain;
    let release: () => void = () => undefined;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class TmuxSessionManager {
  private readonly sessions = new Map<string, TmuxSession>();
  private readonly installLocks = new Map<string, AsyncMutex>();

  private key(environmentId: string, tabId: string): string {
    return `${environmentId}\u001f${tabId}`;
  }

  get(environmentId: string, tabId: string): TmuxSession | undefined {
    return this.sessions.get(this.key(environmentId, tabId));
  }

  insert(environmentId: string, tabId: string, session: TmuxSession): void {
    this.sessions.set(this.key(environmentId, tabId), session);
  }

  remove(environmentId: string, tabId: string): TmuxSession | undefined {
    const key = this.key(environmentId, tabId);
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    return session;
  }

  removeIfSame(environmentId: string, tabId: string, expected: TmuxSession): boolean {
    const key = this.key(environmentId, tabId);
    if (this.sessions.get(key) !== expected) return false;
    this.sessions.delete(key);
    return true;
  }

  /** Drops and returns every session of an environment. Used by teardown. */
  removeEnvironment(environmentId: string): TmuxSession[] {
    const removed: TmuxSession[] = [];
    for (const [key, session] of this.sessions) {
      if (session.environmentId !== environmentId) continue;
      this.sessions.delete(key);
      removed.push(session);
    }
    // The install lock is deliberately kept. Teardown runs *inside* it, so
    // dropping it here would hand a concurrent start a fresh, uncontended lock
    // and let it reinstall hooks under a directory being removed.
    return removed;
  }

  sessionsInEnvironment(environmentId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.environmentId === environmentId) count += 1;
    }
    return count;
  }

  findByTmuxName(environmentId: string, name: string): TmuxSession | undefined {
    for (const session of this.sessions.values()) {
      if (
        session.environmentId === environmentId &&
        tmuxSessionName(session.environmentId, session.tabId) === name
      )
        return session;
    }
    return undefined;
  }

  activityState(environmentId: string): "idle" | "working" | "waiting" {
    let aggregate: "idle" | "working" | "waiting" = "idle";
    for (const session of this.sessions.values()) {
      if (session.environmentId !== environmentId) continue;
      const state = session.activityState();
      if (state === "working") return state;
      if (state === "waiting") aggregate = state;
    }
    return aggregate;
  }

  installLock(environmentId: string): AsyncMutex {
    let mutex = this.installLocks.get(environmentId);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.installLocks.set(environmentId, mutex);
    }
    return mutex;
  }
}

export const tmuxManager = new TmuxSessionManager();
export const tmuxActivityWrites = new Map<string, Promise<void>>();
export const orphanedTmuxMissingSince = new Map<string, number>();
export let lastTmuxOrphanSweepAt = 0;

/** Serialize aggregate writes so an older pane observation cannot land last. */
export function persistTmuxEnvironmentActivity(
  context: CommandContext,
  environmentId: string,
): Promise<void> {
  const storage = context.storage as unknown as {
    getEnvironment?: CommandContext["storage"]["getEnvironment"];
    setEnvironmentAgentActivity?: CommandContext["storage"]["setEnvironmentAgentActivity"];
  };
  // Several command-unit harnesses intentionally provide only the storage
  // methods exercised by that test. Activity persistence is orthogonal there.
  if (!storage.getEnvironment || !storage.setEnvironmentAgentActivity) {
    return Promise.resolve();
  }
  const previous = tmuxActivityWrites.get(environmentId) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const state = tmuxManager.activityState(environmentId);
      const environment = await storage.getEnvironment!(environmentId);
      const persisted = environment?.agentActivitySources?.["claude-tmux"];
      if (persisted?.state === state) return;
      await storage.setEnvironmentAgentActivity!(
        environmentId,
        state,
        new Date().toISOString(),
        "claude-tmux",
      );
    });
  const settled = operation
    .catch((error) => {
      console.warn(
        `[tmux] failed to persist activity for ${environmentId}:`,
        error instanceof Error ? error.message : String(error),
      );
    })
    .finally(() => {
      if (tmuxActivityWrites.get(environmentId) === settled) {
        tmuxActivityWrites.delete(environmentId);
      }
    });
  tmuxActivityWrites.set(environmentId, settled);
  return settled;
}

export function workspaceAndClaudeHome(backend: TmuxBackend): {
  workspace: string;
  claudeHome: string;
} {
  return {
    workspace: backend.kind === "local" ? (backend.cwd ?? process.cwd()) : "/workspace",
    claudeHome: backend.kind === "local" ? localClaudeHome() : "/home/node/.claude",
  };
}

export async function resolveBackend(
  environmentId: string,
  context: CommandContext,
): Promise<TmuxBackend> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`environment ${environmentId} not found`);
  if (environment.environmentType === "local") {
    if (!environment.worktreePath) throw new Error("local environment has no worktree path");
    return TmuxBackend.local(environment.worktreePath);
  }
  if (!environment.containerId) throw new Error("container environment has no container id");
  return TmuxBackend.container(environment.containerId);
}

export function resolveBundledClaudePath(context: CommandContext): string | undefined {
  const candidates = [
    ...(context.toolchainBinDir ? [path.join(context.toolchainBinDir, "claude")] : []),
    path.join(context.resourceRoot, "bin", "claude"),
    path.join(context.appRoot, "binaries", "claude"),
    path.join(context.appRoot, "bin", "claude"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function resolvePinnedClaudeCommand(
  context: CommandContext,
  backend: TmuxBackend,
): string | undefined {
  return backend.kind === "container" ? undefined : resolveBundledClaudePath(context);
}

export async function getOrCreateSession(
  context: CommandContext,
  environmentId: string,
  tabId: string,
  resumeSessionId: string | undefined,
): Promise<TmuxSession> {
  const existing = tmuxManager.get(environmentId, tabId);
  if (existing) return existing;

  const backend = await resolveBackend(environmentId, context);
  const session = new TmuxSession(
    environmentId,
    tabId,
    backend,
    runtimeRootPrefixForContext(context),
    resumeSessionId,
    resolvePinnedClaudeCommand(context, backend),
  );
  tmuxManager.insert(environmentId, tabId, session);
  return session;
}

export async function killOrphanSession(
  context: CommandContext,
  environmentId: string,
  tabId: string,
): Promise<void> {
  try {
    const backend = await resolveBackend(environmentId, context);
    await backend
      .exec(["tmux", "kill-session", "-t", tmuxSessionName(environmentId, tabId)])
      .catch(() => undefined);
  } catch (error) {
    console.debug("[tmux] skipping orphan kill", error);
  }
}

/**
 * Kills every tmux session that belongs to `environmentId`, including ones this
 * process never registered — a backend restart empties `tmuxManager` while the
 * tmux server keeps running the sessions it started.
 *
 * A tmux server with no sessions exits non-zero from `list-sessions`, which is
 * the ordinary "nothing to do" case rather than a failure.
 */
export async function killEnvironmentTmuxSessions(
  backend: TmuxBackend,
  environmentId: string,
  survivingEnvironmentIds: readonly string[],
): Promise<{ killed: string[]; complete: boolean }> {
  const listed = await backend
    .exec(["tmux", "list-sessions", "-F", "#{session_name}"])
    .catch(() => null);
  if (!listed) return { killed: [], complete: false };
  if (listed.status !== 0) {
    const noServer =
      /no server running/i.test(listed.stderr) ||
      /failed to connect to server/i.test(listed.stderr) ||
      /no sessions/i.test(listed.stderr);
    return { killed: [], complete: noServer };
  }
  const targets = selectReapableTmuxSessions({
    names: parseTmuxSessionNames(listed.stdout),
    environmentId,
    survivingEnvironmentIds,
  });
  const killed: string[] = [];
  let complete = true;
  for (const name of targets) {
    const result = await backend
      .exec(["tmux", "kill-session", "-t", name])
      .catch((error) =>
        isMissingTmuxSessionError(error) ? { status: 1, stdout: "", stderr: String(error) } : null,
      );
    if (result?.status === 0) {
      killed.push(name);
    } else if (result && isMissingTmuxSessionError(result.stderr)) {
      // The one-time session listing raced a normal exit. The desired state is
      // already reached, so retaining the runtime root would create a
      // permanent retry loop.
      continue;
    } else {
      complete = false;
    }
  }
  return { killed, complete };
}

/**
 * Tears down every claude-tmux artefact an environment owns, for the deletion
 * path.
 *
 * Deleting an environment used to leave three things behind: the tmux sessions
 * themselves (a tmux server outlives the backend, so they ran forever), the
 * runtime root under `RUNTIME_ROOT_PREFIX`, and — worst — the user's own
 * `.claude/settings.local.json`, which tmux mode overwrites and only restores
 * from its backup on `claude_tmux_stop`. Deleting an environment while a tmux
 * tab was open therefore left the hook block installed in a settings file that
 * outlives the worktree (the local `.claude` directory of a repo checkout).
 *
 * Every step is best-effort and independent: this runs inside a deletion that
 * must complete, so a missing container or an unreachable tmux server must not
 * abort the removal of anything else.
 *
 * Ordering matters at the call site — this needs the container to still exist
 * and the worktree to still be on disk, so it runs before either is removed.
 */

export function getLastTmuxOrphanSweepAt(): number {
  return lastTmuxOrphanSweepAt;
}

export function setLastTmuxOrphanSweepAt(value: number): void {
  lastTmuxOrphanSweepAt = value;
}
