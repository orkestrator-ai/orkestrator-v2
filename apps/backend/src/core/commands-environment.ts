import { withEnvironmentReplacement } from "./container-readiness.js";
import {
  formatContainerLifecycleError,
  parseContainerLifecycle,
  setupCompletionIsCurrent,
  type ContainerLifecycleErrorCode,
  type ContainerMutationIdentity,
  type ContainerStorageIdentity,
  type RecreateEnvironmentRequest,
} from "@orkestrator/protocol/container-lifecycle";
import {
  ensureStorageVolumes,
  initializeStorageSet,
  planStorageSet,
  removeStorageVolumes,
  selectStorageFormat,
  storageHelperFailureMessage,
  verifyStorageSet,
} from "./container-storage.js";
import {
  ContainerInitializationError,
  assertEnvironmentNotDraining,
  containerStopWasForced,
  drainContainerProcesses,
  ensureCurrentBootReady,
  waitForContainerBoot,
  withEnvironmentDraining,
  type DrainResult,
} from "./container-readiness.js";
import {
  advanceContainerOperation,
  beginContainerOperation,
  completeContainerOperation,
  currentRuntimeIdentity,
  nextRuntimeGeneration,
  operationFailureCode,
  releaseActiveContainerOperation,
  resolveContainerOwnership,
  runContainerOperation,
} from "./container-lifecycle-service.js";
import { quiesceRuntime, replaceRuntimePreservingState } from "./container-replacement.js";
import { applyEnvironmentAllowedDomains } from "./container-network.js";
import { providerCredentialsAllowed } from "./portable-input-status.js";
import {
  assertRecoveryCapacity,
  discardRecoveryCopy,
  restoreRecoveryCopy,
  retainedEntriesFor,
  type DiscardCopyResult,
  type RecoveryCopyRequest,
  type RestoreCopyRequest,
} from "./recovery-copies.js";
import { stopEnvironmentReviewValidation } from "./review-validation-service.js";
import { stopEnvironmentExecWorkers } from "./public-api/exec-control.js";
import {
  fs,
  os,
  isIP,
  path,
  spawnPty,
  APP_SLUG,
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_OWNER,
  ORKESTRATOR_PROJECT_CONFIG,
  dockerOwnerNamespace,
  sanitizeBranchName,
  sanitizeEnvironmentName,
  pathExists,
  runCommand,
  shutdownClaudeStatePolling,
} from "./commands-dependencies.js";
import { addLocalWorkspaceArtifactsToGitExclude } from "./commands-files.js";
import { setupTerminalSessionId, isSetupTerminalSessionId } from "./commands-terminal.js";
import {
  CONTAINER_AGENT_TOOLS_HOST,
  DOCKER_CONTAINER_STATE_CACHE_MS,
  DOCKER_DESKTOP_GATEWAY_HOST,
  dockerContainerStateCache,
  dockerExec,
  getDockerStatus,
  getHostPort,
  isContainerRunning,
  parseDockerStatus,
  setDockerContainerStateCache,
} from "./commands-container-exec.js";
import { copyConfiguredProjectFilesToDirectory } from "./commands-project-files.js";
import type {
  Environment,
  EnvironmentStatus,
  PtyProcess,
  StorageService,
  AgentToolConnection,
} from "./commands-dependencies.js";
import { completeTerminalHistory, configureTerminalHistory } from "./terminal-history.js";
import {
  terminalProcesses,
  terminalOutputGenerations,
  CONTAINER_WORKSPACE_SETUP_COMMAND,
  SETUP_DONE_OSC_SEQUENCE,
  SETUP_FAILED_OSC_SEQUENCE,
  SETUP_DONE_PRINTF_CMD,
  SETUP_FAILED_PRINTF_CMD,
  environmentSetupSessions,
  environmentSetupTasks,
  environmentSetupStartTasks,
  environmentStartTasks,
  environmentLifecycleOperations,
  environmentBaselineTasks,
  containerGitFetchPolicy,
  diffStatsService,
  invalidatePendingDiffStatsSync,
  syncDiffStatsTracking,
} from "./commands-runtime-state.js";
import {
  prMonitorService,
  invalidatePendingPrMonitorSync,
  syncPrMonitorTracking,
} from "./commands-pr-monitor.js";
import {
  quoteShell,
  validateGitRefName,
  envWithManagedBinaries,
  configureSameNamedOriginPush,
  allocateGitBranchName,
  createGitBranchCollisionChecker,
} from "./commands-agent-support.js";
import {
  createLocalGhRunner,
  createContainerGhRunner,
  deletePullRequestHeadBranchViaGitHubApi,
  findEnvironmentByContainerId,
} from "./commands-review.js";
import {
  toClientEnvironment,
  terminalOutputBufferLength,
  deleteRetainedTerminalOutputBuffer,
  emitTerminalOutput,
  resetTerminalOutputBuffer,
  logSetupTerminal,
  terminalEnv,
  resolveLocalShellPath,
  cleanupTerminalSession,
  assertEnvironmentNotDeleting,
  assertEnvironmentDeletionNotRequested,
} from "./commands-terminal.js";
import {
  readLocalHeadCommit,
  ensureCreatedFromCommitBeforeSetup,
  enqueueLocalServerEnvironmentOperation,
  stopLocalServersForEnvironmentUnlocked,
  cancelOpenCodeAgentToolsConfiguration,
} from "./commands-local-server-lifecycle.js";
import {
  resolveRemoteWorktreeStartPoint,
  gitRefExists,
  enableGitScanCaches,
  resolveContainerGitHubToken,
  syncContainerGitHubCredential,
  syncContainerClaudeCredentialBestEffort,
  ensureContainerProjectFilesAccess,
} from "./commands-files.js";
import { AmbiguousContainerCreateError, createDockerContainer } from "./commands-containers.js";
import {
  configuredImageRef,
  detectDockerTopology,
  imageCapabilities,
  resolveDockerImage,
} from "./docker-image.js";
import {
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  environmentLifecycleErrorMessage,
  logEnvironmentLifecycleFailure,
} from "./commands-error-text.js";
import type { EnvironmentSetupStartResult } from "./commands-runtime-state.js";
import type { CommandContext, BackendEmit } from "./commands-context.js";

export function spawnTerminalProcess(
  id: string,
  command: string,
  args: string[],
  options: { cwd?: string; cols: number; rows: number; env?: NodeJS.ProcessEnv },
  emit: BackendEmit,
  hooks: { onData?: (data: string) => void; onExit?: () => void } = {},
): PtyProcess {
  const existing = terminalProcesses.get(id);
  if (existing) {
    if (isSetupTerminalSessionId(id)) {
      logSetupTerminal("reusing existing PTY", {
        sessionId: id,
        pid: existing.pid,
      });
    }
    return existing;
  }

  if (isSetupTerminalSessionId(id)) {
    logSetupTerminal("spawning PTY", {
      sessionId: id,
      command,
      args,
      cwd: options.cwd ?? null,
      cols: options.cols,
      rows: options.rows,
    });
  }

  const terminalProcess = spawnPty(command, args, {
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: terminalEnv(options.env),
  });

  terminalProcesses.set(id, terminalProcess);
  if (isSetupTerminalSessionId(id)) {
    logSetupTerminal("PTY spawned", {
      sessionId: id,
      pid: terminalProcess.pid,
    });
  }
  terminalProcess.onData((data) => {
    emitTerminalOutput(id, data, emit);
    hooks.onData?.(data);
  });
  terminalProcess.onExit(({ exitCode, signal }) => {
    if (isSetupTerminalSessionId(id)) {
      logSetupTerminal("PTY exited", {
        sessionId: id,
        exitCode,
        signal,
        bufferChars: terminalOutputBufferLength(id),
      });
    }
    hooks.onExit?.();
    void completeTerminalHistory(id).catch(() => undefined);
    cleanupTerminalSession(id);
  });
  return terminalProcess;
}

export async function inspectDockerContainerIdentity(containerId: string): Promise<{
  owner: string;
  status: EnvironmentStatus;
}> {
  const { stdout } = await runCommand(
    "docker",
    [
      "inspect",
      "-f",
      `{{ index .Config.Labels "${DOCKER_LABEL_OWNER}" }}\t{{.State.Status}}`,
      containerId,
    ],
    { timeoutMs: 10_000 },
  );
  const [owner = "", status = ""] = stdout.trim().split("\t", 2);
  return { owner: owner.trim(), status: parseDockerStatus(status) };
}

/**
 * Docker reports a container the daemon has never heard of, or has already
 * removed, as `no such object`. That is categorically different from a daemon
 * that could not be reached: the first is a definite answer, the second is no
 * answer at all.
 */
export function isMissingDockerObjectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (object|container)/i.test(message);
}

/**
 * Refuses a Docker operation on a container this registry does not own, in
 * every profile. The container must carry this registry's owner label; a
 * pre-label container qualifies only when an environment record already
 * references it (never under a strict profile).
 */
export async function assertDockerContainerOwned(
  containerId: string,
  context: Pick<CommandContext, "storage" | "strictDockerOwner">,
  options: { trustExactAssociation?: boolean } = {},
): Promise<void> {
  const ownership = await resolveContainerOwnership(containerId, context, options);
  // A container the daemon has already forgotten belongs to nobody, so there
  // is nothing here to protect. Refusing would strand the environment: an
  // errored environment is exempt from status reconciliation, so its stale
  // `containerId` never clears, and `recreate`/`delete` — the user's repair
  // actions for exactly this state — would fail identically on every retry.
  if (ownership.verdict === "owned" || ownership.verdict === "missing") return;
  if (ownership.verdict === "unknown") {
    // An unreachable daemon or unreadable answer is not evidence of ownership.
    throw new Error(
      formatContainerLifecycleError(
        "daemon-unavailable",
        "Docker could not confirm who owns this container. Retry once Docker is reachable.",
      ),
    );
  }
  throw new Error(
    formatContainerLifecycleError(
      "not-owned",
      "Refusing Docker operation on a container not owned by this development profile",
    ),
  );
}

/**
 * One `docker ps -a` over the orkestrator label instead of one `docker
 * inspect` per environment. Returns null when Docker is unreachable so
 * callers fall back to their existing per-container handling.
 */
export async function listOrkestratorContainerStates(
  context?: Pick<CommandContext, "storage" | "strictDockerOwner">,
): Promise<Map<string, EnvironmentStatus> | null> {
  try {
    const ownerFilter = context?.strictDockerOwner
      ? [
          "--filter",
          `label=${DOCKER_LABEL_OWNER}=${dockerOwnerNamespace(context.storage.getDataDir())}`,
        ]
      : [];
    const { stdout } = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
        ...ownerFilter,
        "--format",
        "{{.ID}}\t{{.State}}",
      ],
      { timeoutMs: 10_000 },
    );
    const states = new Map<string, EnvironmentStatus>();
    for (const line of stdout.split("\n")) {
      const [id, state] = line.split("\t");
      const containerId = id?.trim();
      if (containerId) states.set(containerId, parseDockerStatus(state ?? ""));
    }
    return states;
  } catch {
    return null;
  }
}

export function getOrkestratorContainerStates(
  context?: Pick<CommandContext, "storage" | "strictDockerOwner">,
): Promise<Map<string, EnvironmentStatus> | null> {
  const now = Date.now();
  const ownershipKey = context?.strictDockerOwner
    ? dockerOwnerNamespace(context.storage.getDataDir())
    : "legacy";
  if (
    dockerContainerStateCache &&
    dockerContainerStateCache.ownershipKey === ownershipKey &&
    now - dockerContainerStateCache.fetchedAt < DOCKER_CONTAINER_STATE_CACHE_MS
  ) {
    return dockerContainerStateCache.states;
  }
  const states = listOrkestratorContainerStates(context);
  setDockerContainerStateCache({ fetchedAt: now, ownershipKey, states });
  return states;
}

export async function syncStoredEnvironmentStatus(
  environment: Environment,
  storage: StorageService,
  knownContainerStates?: Map<string, EnvironmentStatus> | null,
  strictKnownContainerStates = false,
): Promise<Environment> {
  if (environment.environmentType === "local") {
    return environment;
  }

  // Lifecycle state owned by the backend is authoritative over Docker's
  // resource state. During an admitted start the container may not have been
  // persisted yet, and after a failed start Docker may still report a retained
  // container as created or running. Reconciliation must not turn either case
  // into a healthy-looking `stopped`/`creating`/`running` environment.
  //
  // Explicit lifecycle actions clear `lifecycleError` as they commit, so a
  // durable failure remains stable across renderer rehydration and backend
  // restart until the user actually retries or stops the environment.
  if (
    environmentStartTasks.has(environment.id) ||
    environment.status === "error" ||
    Boolean(environment.lifecycleError?.trim())
  ) {
    return environment;
  }

  if (!environment.containerId) {
    if (environment.status !== "stopped") {
      return storage.updateEnvironment(environment.id, { status: "stopped" });
    }
    return environment;
  }

  // Fast path from a shared `docker ps` snapshot — but only when it agrees
  // with the stored status. The snapshot can be a few seconds stale, so a
  // disagreement (or an unlisted container, e.g. one created before the label
  // existed or removed entirely) is always confirmed with a fresh per-container
  // inspect before anything is rewritten. Steady state therefore costs zero
  // inspects; a real transition costs one.
  const knownState = knownContainerStates?.get(environment.containerId);
  if (knownState !== undefined && knownState === environment.status) {
    return environment;
  }
  if (strictKnownContainerStates && knownContainerStates && knownState === undefined) {
    try {
      const identity = await inspectDockerContainerIdentity(environment.containerId);
      const expectedOwner = dockerOwnerNamespace(storage.getDataDir());
      if (identity.owner !== expectedOwner) {
        return storage.updateEnvironment(environment.id, { status: "stopped", containerId: null });
      }
      if (identity.status !== environment.status) {
        return storage.updateEnvironment(environment.id, { status: identity.status });
      }
      return environment;
    } catch (error) {
      if (isMissingDockerObjectError(error)) {
        return storage.updateEnvironment(environment.id, { status: "stopped", containerId: null });
      }
      console.warn(
        "[environment-status] Preserving container state after strict ownership probe failed",
        {
          environmentId: environment.id,
          message: error instanceof Error ? error.message : String(error),
        },
      );
      return environment;
    }
  }

  try {
    const status = await getDockerStatus(environment.containerId);
    if (status !== environment.status) {
      return storage.updateEnvironment(environment.id, { status });
    }
    return environment;
  } catch (error) {
    if (isMissingDockerObjectError(error)) {
      return storage.updateEnvironment(environment.id, { status: "stopped", containerId: null });
    }
    console.warn("[environment-status] Preserving container state after transient Docker error", {
      environmentId: environment.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return environment;
  }
}

export function getWorktreeBaseDir(context?: Pick<CommandContext, "worktreeDir">): string {
  return context?.worktreeDir ?? path.join(os.homedir(), APP_SLUG, "workspaces");
}

export async function readSetupLocalCommands(worktreePath: string): Promise<string[]> {
  const configPath = path.join(worktreePath, ORKESTRATOR_PROJECT_CONFIG);
  if (!(await pathExists(configPath))) return [];

  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as { setupLocal?: unknown };
  if (typeof parsed.setupLocal === "string")
    return parsed.setupLocal.trim() ? [parsed.setupLocal] : [];
  if (Array.isArray(parsed.setupLocal))
    return parsed.setupLocal.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  return [];
}

export async function readEnvironmentSetupCommands(environment: Environment): Promise<string[]> {
  if (environment.setupScriptsComplete) return [];
  if (environment.environmentType === "local") {
    return environment.worktreePath ? readSetupLocalCommands(environment.worktreePath) : [];
  }
  return [CONTAINER_WORKSPACE_SETUP_COMMAND];
}

/**
 * A setup session is attachable as soon as preparation starts, before its PTY
 * exists. The renderer can replay the preparation intro and subscribe to live
 * output once; treating this window as "not running" makes it reconnect and
 * replay the same buffer until preparation finishes.
 */
export function isTerminalSessionAttachable(sessionId: string): boolean {
  if (terminalProcesses.has(sessionId)) return true;
  if (!isSetupTerminalSessionId(sessionId)) return false;

  const environmentId = sessionId.slice(0, -":setup".length);
  const setupSession = environmentSetupSessions.get(environmentId);
  return setupSession?.sessionId === sessionId && setupSession.running;
}

// Setup-session buffers are intentionally retained after the PTY exits so the
// renderer can replay them on reattach. Free them (and the tracked session /
// task state) when the owning environment is removed.
export function cleanupEnvironmentSetupState(environmentId: string): void {
  deleteRetainedTerminalOutputBuffer(setupTerminalSessionId(environmentId));
  environmentSetupSessions.delete(environmentId);
  environmentSetupTasks.delete(environmentId);
  environmentSetupStartTasks.delete(environmentId);
  environmentBaselineTasks.delete(environmentId);
}

export function buildSetupTerminalCommand(commands: string[], finalShellCommand: string): string {
  const combinedCommand = commands.join(" && ");
  return `(${combinedCommand}) && ${SETUP_DONE_PRINTF_CMD} || ${SETUP_FAILED_PRINTF_CMD}; exec ${finalShellCommand}`;
}

export function formatSetupTerminalIntro(environment: Environment, commands: string[]): string {
  const target =
    environment.environmentType === "local"
      ? (environment.worktreePath ?? environment.id)
      : (environment.containerId ?? environment.id);
  const lines = [
    "\r\n",
    "[orkestrator] Starting environment setup",
    `[orkestrator] Environment: ${environment.name} (${environment.id})`,
    `[orkestrator] Target: ${target}`,
    "[orkestrator] Command:",
    ...commands.map((command) => `  ${command}`),
    "",
  ];
  return lines.join("\r\n");
}

export function formatSetupPreparationIntro(environment: Environment): string {
  const target =
    environment.environmentType === "local"
      ? (environment.worktreePath ?? environment.id)
      : (environment.containerId ?? environment.id);
  return [
    "\r\n",
    "[orkestrator] Preparing workspace",
    `[orkestrator] Environment: ${environment.name} (${environment.id})`,
    `[orkestrator] Target: ${target}`,
    "[orkestrator] Cloning the repository and recording the environment creation commit.",
    "[orkestrator] Setup commands run once this finishes.",
    "",
  ].join("\r\n");
}

/** Terminal output is rendered by xterm.js, which needs CRLF rather than bare LF. */
export function toTerminalText(output: string): string {
  return output.replace(/\r?\n/g, "\r\n");
}

/**
 * Opens the setup terminal session *before* the workspace preparation exec runs.
 *
 * Preparation performs the clone, so it can take minutes; without this the user
 * watches a blank panel until it finishes, because the setup terminal used to be
 * created only afterwards.
 */
export function beginSetupPreparationSession(
  environment: Environment,
  context: CommandContext,
): string {
  const sessionId = setupTerminalSessionId(environment.id);
  resetTerminalOutputBuffer(sessionId);
  configureTerminalHistory({
    sessionId,
    dataDir: context.storage.getDataDir(),
    stableIdentity: `setup\0${environment.id}`,
    cols: 80,
    rows: 24,
    environmentId: environment.id,
    tabId: "setup",
    generation: terminalOutputGenerations.get(sessionId) ?? 1,
  });
  environmentSetupSessions.set(environment.id, {
    environmentId: environment.id,
    sessionId,
    running: true,
    startedAt: new Date().toISOString(),
  });
  logSetupTerminal("preparing workspace", {
    environmentId: environment.id,
    environmentName: environment.name,
    environmentType: environment.environmentType,
    sessionId,
  });
  emitTerminalOutput(sessionId, formatSetupPreparationIntro(environment), context.emit);
  context.emit("environment-setup-started", {
    environment_id: environment.id,
    session_id: sessionId,
    environment: toClientEnvironment(environment),
  });
  return sessionId;
}

export function createSetupCompletionTracker(): {
  completion: Promise<boolean>;
  onData: (data: string) => void;
  onExit: () => void;
} {
  let settled = false;
  let resolveCompletion!: (success: boolean) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<boolean>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const finish = (success: boolean) => {
    if (settled) return;
    settled = true;
    resolveCompletion(success);
  };

  // PTY reads are not guaranteed to align to write boundaries, so the OSC
  // completion marker can arrive split across two `onData` chunks. Keep a small
  // rolling tail of the previous chunk (one byte short of the longest marker)
  // and prepend it before matching so a split marker is still detected.
  const markerTailLength =
    Math.max(SETUP_DONE_OSC_SEQUENCE.length, SETUP_FAILED_OSC_SEQUENCE.length) - 1;
  let pending = "";

  return {
    completion,
    onData: (data) => {
      const combined = `${pending}${data}`;
      if (combined.includes(SETUP_DONE_OSC_SEQUENCE)) {
        finish(true);
      } else if (combined.includes(SETUP_FAILED_OSC_SEQUENCE)) {
        finish(false);
      }
      pending = markerTailLength > 0 ? combined.slice(-markerTailLength) : "";
    },
    onExit: () => {
      if (settled) return;
      settled = true;
      rejectCompletion(new Error("Setup terminal exited before reporting completion"));
    },
  };
}

export async function spawnSetupTerminal(
  environment: Environment,
  commands: string[],
  context: CommandContext,
  options: { continuesPreparationSession?: boolean } = {},
): Promise<{ sessionId: string; completion: Promise<boolean> }> {
  const sessionId = setupTerminalSessionId(environment.id);
  const tracker = createSetupCompletionTracker();
  logSetupTerminal("creating setup session", {
    environmentId: environment.id,
    environmentName: environment.name,
    environmentType: environment.environmentType,
    sessionId,
    commandCount: commands.length,
    worktreePath: environment.worktreePath ?? null,
    containerId: environment.containerId ?? null,
  });

  const existingSession = options.continuesPreparationSession
    ? environmentSetupSessions.get(environment.id)
    : undefined;
  // A retry starts a clean buffer; a run that already streamed its preparation
  // output into this session keeps it, so the clone log stays visible.
  if (!existingSession) resetTerminalOutputBuffer(sessionId);
  environmentSetupSessions.set(environment.id, {
    environmentId: environment.id,
    sessionId,
    running: true,
    startedAt: existingSession?.startedAt ?? new Date().toISOString(),
  });
  configureTerminalHistory({
    sessionId,
    dataDir: context.storage.getDataDir(),
    stableIdentity: `setup\0${environment.id}`,
    cols: 80,
    rows: 24,
    environmentId: environment.id,
    tabId: "setup",
    generation: terminalOutputGenerations.get(sessionId) ?? 1,
  });

  if (environment.environmentType === "local") {
    if (!environment.worktreePath)
      throw new Error(`Local environment worktree is not available: ${environment.id}`);
    if (!(await pathExists(environment.worktreePath))) {
      throw new Error(`Local environment worktree does not exist: ${environment.worktreePath}`);
    }
    const shellPath = resolveLocalShellPath();
    const setupCommand = buildSetupTerminalCommand(commands, `${quoteShell(shellPath)} -l`);
    spawnTerminalProcess(
      sessionId,
      shellPath,
      // Use an interactive login shell (-i) so PATH entries that tool installers
      // (bun, nvm, etc.) append to ~/.bashrc are available. The standard Debian
      // ~/.bashrc returns early for non-interactive shells (case $- in *i*)),
      // so a plain `-lc` login shell never sees those exports and `bun` etc. are
      // "command not found". This mirrors what fix-path.ts does when recovering
      // the login-shell PATH.
      ["-ilc", setupCommand],
      {
        cwd: environment.worktreePath,
        cols: 80,
        rows: 24,
        env: envWithManagedBinaries(context),
      },
      context.emit,
      { onData: tracker.onData, onExit: tracker.onExit },
    );
  } else {
    if (!environment.containerId)
      throw new Error(`Environment has no container: ${environment.id}`);
    if (!(await isContainerRunning(environment.containerId))) {
      throw new Error(`Container is not running: ${environment.containerId}`);
    }
    const setupCommand = buildSetupTerminalCommand(commands, "zsh -l");
    spawnTerminalProcess(
      sessionId,
      "docker",
      ["exec", "-it", environment.containerId, "zsh", "-lc", setupCommand],
      { cols: 80, rows: 24 },
      context.emit,
      { onData: tracker.onData, onExit: tracker.onExit },
    );
  }

  emitTerminalOutput(sessionId, formatSetupTerminalIntro(environment, commands), context.emit);
  logSetupTerminal("emitted setup intro", {
    environmentId: environment.id,
    sessionId,
    bufferChars: terminalOutputBufferLength(sessionId),
  });

  context.emit("environment-setup-started", {
    environment_id: environment.id,
    session_id: sessionId,
    environment: toClientEnvironment(environment),
  });

  return { sessionId, completion: tracker.completion };
}

export async function completeEnvironmentSetup(
  environment: Environment,
  context: CommandContext,
): Promise<Environment> {
  if (!environment.createdFromCommit) {
    throw new Error(
      `Environment creation commit was not captured before setup completed: ${environment.id}`,
    );
  }
  let updated = await context.storage.updateEnvironment(environment.id, {
    setupScriptsComplete: true,
    setupPhase: "ready",
    setupOverride: false,
    setupCompletedAt: new Date().toISOString(),
  });
  // Bind the completion to the runtime and workspace it describes, so a later
  // replacement cannot inherit it.
  updated = await recordSetupCompletion(updated, context).catch(() => updated);
  if (updated.pendingAgentLaunch && context.nativeAgents) {
    await context.nativeAgents.reconcileInitialLaunch(updated.id).catch(() => {
      // The service persists a sanitized retryable launch error. Setup itself
      // succeeded and must not be rolled back because an agent bridge was
      // temporarily unavailable.
    });
    updated = (await context.storage.getEnvironment(updated.id)) ?? updated;
  }
  const session = environmentSetupSessions.get(environment.id);
  logSetupTerminal("setup completed", {
    environmentId: environment.id,
    sessionId: session?.sessionId ?? null,
    bufferChars: session?.sessionId ? terminalOutputBufferLength(session.sessionId) : 0,
  });
  if (session) {
    environmentSetupSessions.set(environment.id, {
      ...session,
      running: false,
      completedAt: new Date().toISOString(),
      success: true,
    });
  }
  context.emit("environment-setup-complete", {
    environment_id: environment.id,
    success: true,
    environment: toClientEnvironment(updated),
  });
  return updated;
}

export function clearPendingAgentLaunchUpdates(): Partial<Environment> {
  return {
    pendingAgentLaunch: false,
    initialAgentPlatform: undefined,
    initialAgentModel: undefined,
    initialReasoningEffort: undefined,
    initialFastMode: undefined,
    initialConversationMode: undefined,
    initialPromptAttachments: undefined,
  };
}

export async function failEnvironmentSetup(
  environmentId: string,
  error: unknown,
  context: CommandContext,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const lifecycleError = environmentLifecycleErrorMessage(error);
  const session = environmentSetupSessions.get(environmentId);
  logSetupTerminal("setup failed", {
    environmentId,
    sessionId: session?.sessionId ?? null,
    error: message,
    bufferChars: session?.sessionId ? terminalOutputBufferLength(session.sessionId) : 0,
  });
  if (session) {
    environmentSetupSessions.set(environmentId, {
      ...session,
      running: false,
      completedAt: new Date().toISOString(),
      success: false,
      error: message,
    });
  }
  // A post-setup agent launch can no longer be honoured: the workspace never
  // became ready. Clearing the durable intent here is what stops it outliving
  // this attempt — the renderer only clears it once an agent tab exists, so a
  // failed setup would otherwise leave the flag set forever and auto-dispatch
  // the original prompt whenever the environment is next started.
  let updated: Environment | undefined;
  try {
    updated = await context.storage.updateEnvironment(environmentId, {
      status: "error",
      setupPhase: "failed",
      setupCompletedAt: new Date().toISOString(),
      lifecycleError,
      ...clearPendingAgentLaunchUpdates(),
    });
  } catch (clearError) {
    console.warn(`[setup] Failed to clear pending agent launch for ${environmentId}:`, clearError);
  }
  context.emit("environment-setup-complete", {
    environment_id: environmentId,
    success: false,
    error: message,
    ...(updated ? { environment: toClientEnvironment(updated) } : {}),
  });
}

export async function failEnvironmentSetupBeforeAttempt(
  environmentId: string,
  error: unknown,
  context: CommandContext,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const lifecycleError = environmentLifecycleErrorMessage(error);
  let updated: Environment | undefined;
  try {
    // No setup session or PTY was published, so this is a retryable preparation
    // failure rather than proof that the running workspace is unusable. Keep
    // both the environment status and the durable initial-agent launch intent.
    updated = await context.storage.updateEnvironment(environmentId, {
      setupPhase: "failed",
      setupCompletedAt: new Date().toISOString(),
      lifecycleError,
    });
  } catch (updateError) {
    console.warn(
      `[setup] Failed to record pre-attempt setup failure for ${environmentId}:`,
      updateError,
    );
  }
  context.emit("environment-setup-complete", {
    environment_id: environmentId,
    success: false,
    error: message,
    ...(updated ? { environment: toClientEnvironment(updated) } : {}),
  });
}

export async function startEnvironmentSetupOnce(
  environment: Environment,
  context: CommandContext,
): Promise<EnvironmentSetupStartResult> {
  assertEnvironmentNotDraining(environment.id);
  const current = (await context.storage.getEnvironment(environment.id)) ?? environment;
  if (
    (current.setupScriptsComplete ||
      current.setupPhase === "ready" ||
      current.setupOverride === true) &&
    setupCompletionBelongsToRuntime(current)
  ) {
    logSetupTerminal("setup already complete", {
      environmentId: current.id,
      environmentName: current.name,
      environmentType: current.environmentType,
    });
    return {
      setupStarted: false,
      environment: current,
    };
  }

  // Preparation clones the repository, so the session is opened before it starts
  // and its output streamed there. Nothing else can move that session out of
  // "running" until a PTY exists, so every failure between here and the spawn has
  // to close it explicitly or it reports a setup that is running forever.
  const setupSessionId = setupTerminalSessionId(current.id);
  const running = await context.storage.updateEnvironment(current.id, {
    // A setup-script failure marks the environment error even though its
    // container/worktree remains usable. Retrying re-enters the normal running
    // lifecycle so a later successful setup satisfies agent readiness.
    status: "running",
    setupScriptsComplete: false,
    setupPhase: "running",
    setupOverride: false,
    setupSessionId,
    setupStartedAt: new Date().toISOString(),
    setupCompletedAt: undefined,
    lifecycleError: null,
  });
  const preparationSessionId = running.createdFromCommit
    ? undefined
    : beginSetupPreparationSession(running, context);
  try {
    return await startEnvironmentSetupAfterPreparation(running, context, preparationSessionId);
  } catch (error) {
    // Both a preparation continuation and a retry with an existing baseline can
    // publish a logical setup session before the PTY is available. Any startup
    // failure after that point must close the session; otherwise
    // get_terminal_session keeps reporting an attachable terminal that has no
    // process behind it. Avoid manufacturing a failure session for errors that
    // happened before an attempt published one.
    if (environmentSetupSessions.get(running.id)?.running) {
      await failEnvironmentSetup(running.id, error, context);
    } else {
      await failEnvironmentSetupBeforeAttempt(running.id, error, context);
    }
    throw error;
  }
}

export async function startEnvironmentSetupAfterPreparation(
  environment: Environment,
  context: CommandContext,
  preparationSessionId: string | undefined,
): Promise<EnvironmentSetupStartResult> {
  const current = await prepareEnvironmentForSetup(environment, context, (chunk) => {
    if (preparationSessionId && chunk) {
      emitTerminalOutput(preparationSessionId, toTerminalText(chunk), context.emit);
    }
  });

  const commands = await readEnvironmentSetupCommands(current);
  if (commands.length === 0) {
    logSetupTerminal("no setup commands found", {
      environmentId: current.id,
      environmentName: current.name,
      environmentType: current.environmentType,
      worktreePath: current.worktreePath ?? null,
      containerId: current.containerId ?? null,
    });
    const updated = await completeEnvironmentSetup(current, context);
    return {
      setupStarted: false,
      environment: updated,
    };
  }

  const existingTask = environmentSetupTasks.get(current.id);
  const existingSession = environmentSetupSessions.get(current.id);
  if (existingTask && existingSession) {
    logSetupTerminal("setup already running", {
      environmentId: current.id,
      sessionId: existingSession.sessionId,
      terminalRunning: terminalProcesses.has(existingSession.sessionId),
      bufferChars: terminalOutputBufferLength(existingSession.sessionId),
    });
    return {
      setupStarted: true,
      setupSessionId: existingSession.sessionId,
      environment: current,
    };
  }

  const { sessionId, completion } = await spawnSetupTerminal(current, commands, context, {
    continuesPreparationSession: preparationSessionId !== undefined,
  });
  const task = completion
    .then(async (success) => {
      if (!success) {
        throw new Error("Setup script failed");
      }
      return completeEnvironmentSetup(current, context);
    })
    .catch(async (error) => {
      await failEnvironmentSetup(current.id, error, context);
      throw error;
    })
    .finally(() => {
      environmentSetupTasks.delete(current.id);
    });

  environmentSetupTasks.set(current.id, task);
  void task.catch(() => undefined);

  return {
    setupStarted: true,
    setupSessionId: sessionId,
    environment: current,
  };
}

export function startEnvironmentSetup(
  environment: Environment,
  context: CommandContext,
): Promise<EnvironmentSetupStartResult> {
  const existing = environmentSetupStartTasks.get(environment.id);
  if (existing) return existing;

  const task = startEnvironmentSetupOnce(environment, context).finally(() => {
    if (environmentSetupStartTasks.get(environment.id) === task) {
      environmentSetupStartTasks.delete(environment.id);
    }
  });
  environmentSetupStartTasks.set(environment.id, task);
  return task;
}

type DelegationCommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

export async function reconcileContainerDelegationBase(
  environment: Pick<Environment, "branch" | "delegationBaseCommit">,
  containerId: string,
  execute: DelegationCommandRunner = runCommand,
): Promise<void> {
  const commit = environment.delegationBaseCommit;
  if (!commit) return;
  await execute(
    "docker",
    ["exec", containerId, "git", "-C", "/workspace", "cat-file", "-e", `${commit}^{commit}`],
    { timeoutMs: 30_000 },
  ).catch(() => {
    throw new Error(
      "The delegated commit is unavailable in the container clone; publish it to the remote or use a local worker",
    );
  });
  const currentHead = (
    await execute("docker", ["exec", containerId, "git", "-C", "/workspace", "rev-parse", "HEAD"], {
      timeoutMs: 30_000,
    })
  ).stdout.trim();
  const currentBranch = (
    await execute(
      "docker",
      ["exec", containerId, "git", "-C", "/workspace", "branch", "--show-current"],
      { timeoutMs: 30_000 },
    )
  ).stdout.trim();
  if (currentHead === commit && currentBranch === environment.branch) return;

  const dirty = (
    await execute(
      "docker",
      ["exec", containerId, "git", "-C", "/workspace", "status", "--porcelain"],
      { timeoutMs: 30_000 },
    )
  ).stdout.trim();
  if (dirty) {
    throw new Error(
      "Cannot reconcile the delegated base commit because the worker checkout has changes",
    );
  }
  if (currentBranch !== environment.branch) {
    const branchExists = await execute(
      "docker",
      [
        "exec",
        containerId,
        "git",
        "-C",
        "/workspace",
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${environment.branch}`,
      ],
      { timeoutMs: 30_000 },
    ).then(
      () => true,
      () => false,
    );
    await execute(
      "docker",
      [
        "exec",
        containerId,
        "git",
        "-C",
        "/workspace",
        "switch",
        ...(branchExists ? [] : ["-c"]),
        environment.branch,
        ...(branchExists ? [] : [commit]),
      ],
      { timeoutMs: 30_000 },
    );
  }
  await execute(
    "docker",
    ["exec", containerId, "git", "-C", "/workspace", "reset", "--hard", commit],
    { timeoutMs: 30_000 },
  );
}

export async function reconcilePreparedContainerDelegation(
  environment: Environment,
  context: CommandContext,
  reconcile: typeof reconcileContainerDelegationBase = reconcileContainerDelegationBase,
): Promise<Environment> {
  if (
    environment.environmentType !== "containerized" ||
    !environment.containerId ||
    !environment.delegationBaseCommit ||
    environment.createdFromCommit === environment.delegationBaseCommit
  ) {
    return environment;
  }
  await reconcile(environment, environment.containerId);
  return context.storage.updateEnvironment(environment.id, {
    createdFromCommit: environment.delegationBaseCommit,
  });
}

export async function prepareEnvironmentForSetup(
  environment: Environment,
  context: CommandContext,
  onPrepareOutput?: (chunk: string) => void,
  prepare: typeof ensureCreatedFromCommitBeforeSetup = ensureCreatedFromCommitBeforeSetup,
  reconcile: typeof reconcilePreparedContainerDelegation = reconcilePreparedContainerDelegation,
): Promise<Environment> {
  // Immediately before repository work runs in the container: if Docker
  // restarted it since the start was admitted, wait for the new boot.
  if (environment.environmentType === "containerized" && environment.containerId) {
    await ensureCurrentBootReady(environment.containerId);
  }
  const prepared = await prepare(environment, context, onPrepareOutput);
  // Container preparation owns the initial clone. Reconcile an explicit
  // delegation base only after that clone exists, but before project setup
  // scripts run against it.
  return reconcile(prepared, context);
}

async function verifyRuntimeStorage(
  environment: Environment,
  context: CommandContext,
): Promise<void> {
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  if (!parsed.supported || parsed.record.storage.format !== "volume-v1") return;
  const imageId = currentRuntimeIdentity(environment, context)?.imageId;
  if (!imageId) return;
  const verified = await verifyStorageSet(context, imageId, environment.id, parsed.record.storage);
  if (!verified.ok) {
    throw new Error(
      formatContainerLifecycleError("needs-attention", storageHelperFailureMessage(verified)),
    );
  }
}

async function discardPersistentStorage(
  context: CommandContext,
  environmentId: string,
  operationId: string,
): Promise<ContainerStorageIdentity | undefined> {
  const environment = await context.storage.getEnvironment(environmentId);
  const parsed = parseContainerLifecycle(environment?.containerLifecycle);
  if (!environment || !parsed.supported || parsed.record.storage.format !== "volume-v1") {
    return undefined;
  }
  const storage = parsed.record.storage;
  const kept = await removeStorageVolumes(context, environmentId, storage);
  if (kept && kept.length > 0) {
    await context.storage.updateEnvironment(environmentId, {
      containerLifecycle: {
        ...parsed.record,
        revision: parsed.record.revision + 1,
        retainedStorage: [
          ...(parsed.record.retainedStorage ?? []),
          {
            storageSetId: storage.storageSetId ?? "unknown",
            workspaceGeneration: storage.workspaceGeneration,
            volumes: kept,
            retainedAt: new Date().toISOString(),
            reason: "workspace-reset",
            operationId,
          },
        ],
      },
    });
  }
  return { format: "legacy-layer", workspaceGeneration: storage.workspaceGeneration + 1 };
}

/**
 * Chooses and prepares the storage a new runtime mounts. An environment whose
 * lifecycle already names a persistent storage set keeps it (verified before
 * it is mounted read-write). One without — a new environment, or one whose
 * legacy runtime was discarded — gets persistent volumes when the image and
 * daemon support them. Planned volume names are persisted before any volume
 * is created so an interrupted attempt adopts exactly those volumes.
 */
async function prepareRuntimeStorage(
  environment: Environment,
  context: CommandContext,
  operationId: string,
  imageId: string | undefined,
): Promise<ContainerStorageIdentity | undefined> {
  const current = (await context.storage.getEnvironment(environment.id)) ?? environment;
  const parsed = parseContainerLifecycle(current.containerLifecycle);
  if (!parsed.supported) return undefined;
  let storage = parsed.record.storage;
  if (storage.format !== "volume-v1") {
    if (!imageId) return undefined;
    const decision = selectStorageFormat(
      await imageCapabilities(imageId, context),
      await detectDockerTopology(),
    );
    if (decision.format !== "volume-v1") return undefined;
    storage = planStorageSet(
      environment.id,
      dockerOwnerNamespace(context.storage.getDataDir()),
      storage.workspaceGeneration,
    );
    await advanceContainerOperation(context, environment.id, operationId, {
      phase: "allocating-storage",
      storage,
    });
  }
  if (!imageId) {
    throw new Error(
      formatContainerLifecycleError(
        "capability-unavailable",
        "The environment image could not be identified, so its persistent storage cannot be checked.",
      ),
    );
  }
  await ensureStorageVolumes(context, environment.id, storage);
  const initialized = await initializeStorageSet(context, imageId, environment.id, storage);
  if (!initialized.ok) {
    throw new Error(
      formatContainerLifecycleError("needs-attention", storageHelperFailureMessage(initialized)),
    );
  }
  return storage;
}

/**
 * Whether the environment's recorded setup completion describes its current
 * runtime and workspace (see `setupCompletionIsCurrent`).
 */
export function setupCompletionBelongsToRuntime(environment: Environment): boolean {
  if (environment.environmentType !== "containerized") return true;
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  return parsed.supported ? setupCompletionIsCurrent(parsed.record) : true;
}

async function recordSetupCompletion(
  environment: Environment,
  context: CommandContext,
): Promise<Environment> {
  if (environment.environmentType !== "containerized" || !environment.containerLifecycle) {
    return environment;
  }
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  if (!parsed.supported) return environment;
  const record = parsed.record;
  return context.storage.updateEnvironment(environment.id, {
    containerLifecycle: {
      ...record,
      revision: record.revision + 1,
      setup: {
        runtimeGeneration: record.runtime?.runtimeGeneration ?? record.lastRuntimeGeneration,
        workspaceGeneration: record.storage.workspaceGeneration,
        completedAt: new Date().toISOString(),
      },
    },
  });
}

/**
 * Resolves the configured image tag once, at admission, to its immutable id.
 * The id is persisted with the operation and used for the create, so a tag
 * moved mid-operation cannot change what the candidate runs. A missing image
 * fails here with the image-unavailable classification; an answer that cannot
 * be read leaves the create to report the daemon's own error.
 */
export async function resolveOperationImage(
  context: Pick<CommandContext, "dockerImage">,
): Promise<{ imageRef: string; imageId?: string; registryDigest?: string }> {
  const imageRef = configuredImageRef(context);
  const resolved = await resolveDockerImage(imageRef);
  if (resolved.kind === "missing") {
    throw new Error(`No such image: ${imageRef}`);
  }
  if (resolved.kind !== "present") return { imageRef };
  return {
    imageRef,
    imageId: resolved.imageId,
    ...(resolved.registryDigest ? { registryDigest: resolved.registryDigest } : {}),
  };
}

/**
 * Creates (when needed) and starts an environment's container as one durable
 * lifecycle operation. Each phase is persisted before its Docker effect, the
 * create is labelled with the operation id, and the container id is committed
 * together with its runtime identity.
 */
async function startContainerRuntime(
  environment: Environment,
  context: CommandContext,
  identity: ContainerMutationIdentity,
): Promise<{ containerId: string; replayed: false } | { replayed: true }> {
  // Authorize before admission: a refused request records nothing. A
  // container this operation creates carries this registry's labels by
  // construction, so only an existing one is verified.
  if (environment.containerId) await assertDockerContainerOwned(environment.containerId, context);
  const admission = await beginContainerOperation(
    context,
    environment.id,
    environment.containerId ? "start" : "create",
    { ...identity, source: currentRuntimeIdentity(environment, context) },
  );
  if (admission.kind === "replayed") return { replayed: true };
  const { operationId } = admission.operation;
  let unpersistedContainerId: string | null = null;
  try {
    let containerId = environment.containerId;
    if (!containerId) {
      const runtimeGeneration = nextRuntimeGeneration(environment);
      const image = await resolveOperationImage(context);
      const storage = await prepareRuntimeStorage(environment, context, operationId, image.imageId);
      await advanceContainerOperation(context, environment.id, operationId, {
        phase: "creating",
        details: { generation: runtimeGeneration, ...image },
      });
      containerId = await createDockerContainer(environment, context, {
        operationId,
        runtimeGeneration,
        imageId: image.imageId,
        storage,
      });
      unpersistedContainerId = containerId;
      await advanceContainerOperation(context, environment.id, operationId, {
        phase: "created",
        runtime: {
          containerId,
          runtimeGeneration,
          owner: dockerOwnerNamespace(context.storage.getDataDir()),
          ...image,
          createdByOperationId: operationId,
        },
        environment: { containerId },
      });
      unpersistedContainerId = null;
    } else {
      // Persistent volumes are verified against their private markers before
      // the runtime mounts them read-write again. A missing or foreign marker
      // is a recovery condition, never a reason to reinitialize.
      await verifyRuntimeStorage(environment, context);
    }
    await advanceContainerOperation(context, environment.id, operationId, {
      phase: "starting",
      boot: { phase: "starting" },
    });
    await runCommand("docker", ["start", containerId], { timeoutMs: 60_000 });
    await ensureContainerProjectFilesAccess(containerId);
    // Readiness belongs to this boot: nothing is prepared or launched until
    // the entrypoint reports ready for the current PID 1. Legacy images have
    // no boot status and keep their previous behavior.
    const started = await context.storage.getEnvironment(environment.id);
    const runtime = started ? currentRuntimeIdentity(started, context) : undefined;
    const capabilities = await imageCapabilities(runtime?.imageId, context);
    if (capabilities?.["boot-status"]) {
      await advanceContainerOperation(context, environment.id, operationId, {
        phase: "initializing",
        boot: { phase: "initializing" },
      });
      try {
        const bootId = await waitForContainerBoot(containerId);
        await advanceContainerOperation(context, environment.id, operationId, {
          boot: { phase: "ready", ...(bootId ? { bootId } : {}) },
          ...(runtime && bootId ? { runtime: { ...runtime, bootId } } : {}),
        });
      } catch (error) {
        if (error instanceof ContainerInitializationError) {
          await advanceContainerOperation(context, environment.id, operationId, {
            boot: {
              phase: "failed",
              ...(error.failureCode ? { failureCode: error.failureCode } : {}),
            },
          }).catch(() => undefined);
        }
        throw error;
      }
    }
    // A container boots with the allowlist it stored last; an edit saved
    // while it was stopped (or one an interrupted apply never reached) is
    // applied now. Failure leaves it reported as pending, not the start.
    if (capabilities?.["network-refresh"]) {
      await applyEnvironmentAllowedDomains(environment.id, context).catch(() => undefined);
    }
    await completeContainerOperation(context, environment.id, operationId, "succeeded");
    return { containerId, replayed: false };
  } catch (error) {
    if (error instanceof AmbiguousContainerCreateError) {
      // Leave the operation current: the next admission reconciles it by the
      // operation label rather than creating a second container.
      releaseActiveContainerOperation(context, operationId);
      throw error;
    }
    if (unpersistedContainerId) {
      // Created but never committed. Removing it keeps the deterministic name
      // free; if Docker refuses, the operation label lets reconciliation adopt
      // it instead of creating another.
      await runCommand("docker", ["rm", "-f", unpersistedContainerId], {
        timeoutMs: 60_000,
      }).catch(() => undefined);
    }
    await completeContainerOperation(context, environment.id, operationId, "failed", {
      failureCode: operationFailureCode(error),
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * Starts an assigned container without running environment setup, as the
 * legacy `docker_start_container` command did, but through the lifecycle queue
 * and a durable operation like every other container mutation.
 */
export function startAssignedContainerRuntimeTask(
  environmentId: string,
  context: CommandContext,
  identity: ContainerMutationIdentity = {},
): Promise<string | null> {
  return enqueueEnvironmentLifecycleOperation(environmentId, context, async () => {
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    assertEnvironmentNotDeleting(environment.id);
    assertEnvironmentDeletionNotRequested(environment, environment.id);
    if (!environment.containerId) return null;
    const runtime = await startContainerRuntime(environment, context, identity);
    return runtime.replayed ? environment.containerId : runtime.containerId;
  });
}

export async function startEnvironmentOnce(
  environmentId: string,
  context: CommandContext,
  schedulePendingRename: (environmentId: string, context: CommandContext) => void,
  identity: ContainerMutationIdentity = {},
): Promise<EnvironmentSetupStartResult> {
  const { storage } = context;
  const environment = await storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  // Admission checks make the common case fail early. This second check is
  // required because the start may have waited behind another lifecycle
  // operation while a durable deletion tombstone was persisted.
  assertEnvironmentNotDeleting(environment.id);
  assertEnvironmentDeletionNotRequested(environment, environment.id);
  // Rolling back a worktree needs the repository it was added to and the branch
  // it created, not just the directory: `git worktree add -b` makes both.
  let unpersistedWorktree: { projectPath: string; path: string; branch: string } | null = null;

  try {
    if (environment.status !== "running") {
      // Starting a stopped/error environment establishes a new runtime
      // generation. Any pane-carried PTY id names the previous generation and
      // must be removed before a renderer can attempt to attach to it.
      // Command-registry compatibility fixtures use deliberately partial
      // storage adapters; production StorageService always provides this.
      await storage.clearBackendTerminalSessionIds?.(environment.id);
    }
    await storage.updateEnvironment(environment.id, {
      status: "creating",
      lifecycleError: null,
    });
    if (environment.environmentType === "local") {
      if (environment.worktreePath && (await pathExists(environment.worktreePath))) {
        const running = await storage.updateEnvironment(environment.id, {
          status: "running",
          lifecycleError: null,
        });
        const result = await startEnvironmentSetup(running, context);
        schedulePendingRename(environment.id, context);
        await syncDiffStatsTracking(context);
        await syncPrMonitorTracking(context);
        return result;
      }
      const project = await storage.getProject(environment.projectId);
      if (!project?.localPath)
        throw new Error("Project has no local path - cannot create a local worktree");
      const repoConfig = await storage.getRepositoryConfig(project.id);
      const worktree = await createLocalWorktree(
        project.localPath,
        project.name,
        environment.branch,
        environment.delegationBaseCommit ?? repoConfig.defaultBranch,
        repoConfig.filesToCopy,
        getWorktreeBaseDir(context),
      );
      unpersistedWorktree = {
        projectPath: project.localPath,
        path: worktree.path,
        branch: worktree.branch,
      };
      const updated = await storage.updateEnvironment(environment.id, {
        worktreePath: worktree.path,
        branch: worktree.branch,
        createdFromCommit: worktree.createdFromCommit,
        status: "running",
        lifecycleError: null,
      });
      unpersistedWorktree = null;
      const result = await startEnvironmentSetup(updated, context);
      schedulePendingRename(environment.id, context);
      await syncDiffStatsTracking(context);
      await syncPrMonitorTracking(context);
      return result;
    }

    const runtime = await startContainerRuntime(environment, context, identity);
    if (runtime.replayed) {
      // The identical request already completed; its effects are not repeated.
      const current = (await storage.getEnvironment(environment.id)) ?? environment;
      return { setupStarted: false, environment: current };
    }
    const containerId = runtime.containerId;
    // An already-prepared delegated checkout is reconciled on every restart.
    // A fresh checkout is handled by startEnvironmentSetupAfterPreparation,
    // after prepareContainerWorkspace has cloned /workspace.
    if (environment.delegationBaseCommit && environment.createdFromCommit) {
      await reconcileContainerDelegationBase(environment, containerId);
      if (environment.createdFromCommit !== environment.delegationBaseCommit) {
        await storage.updateEnvironment(environment.id, {
          createdFromCommit: environment.delegationBaseCommit,
        });
      }
    }
    const config = await storage.loadConfig();
    if (context.runtimeFlavor !== "agent-test") {
      const githubToken = await resolveContainerGitHubToken(config.global);
      await syncContainerGitHubCredential(containerId, githubToken);
    }
    if (
      providerCredentialsAllowed(
        context,
        config.global.enabledAgentPlatforms,
        environment,
        "claude",
      )
    ) {
      await syncContainerClaudeCredentialBestEffort(containerId, config.global);
    }
    const hostEntryPort = environment.entryPort
      ? await getHostPort(containerId, environment.entryPort)
      : null;
    const updated = await storage.updateEnvironment(environment.id, {
      status: "running",
      entryPort: environment.entryPort ?? null,
      hostEntryPort,
      lifecycleError: null,
    });
    const result = await startEnvironmentSetup(updated, context);
    schedulePendingRename(environment.id, context);
    await syncDiffStatsTracking(context);
    await syncPrMonitorTracking(context);
    return result;
  } catch (error) {
    logEnvironmentLifecycleFailure("start", environment.id, error);
    const lifecycleError = environmentLifecycleErrorMessage(error);
    if (unpersistedWorktree) {
      // `git worktree add -b` created a branch too. Leaving it behind makes the
      // next start's uniqueness loop pick `<slug>-1`, drifting the environment's
      // branch name further on every retry.
      await cleanupFailedLocalWorktree(
        unpersistedWorktree.projectPath,
        unpersistedWorktree.path,
        unpersistedWorktree.branch,
      ).catch(() => undefined);
    }
    await storage
      .updateEnvironment(environment.id, {
        status: "error",
        lifecycleError,
        // A start that never reached "running" cannot honour a post-setup agent
        // launch, and the durable intent would otherwise fire on some later
        // successful transition the user never connected to this attempt.
        ...clearPendingAgentLaunchUpdates(),
      })
      .catch(() => undefined);
    if (lifecycleError === ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitSshAuthentication) {
      throw new Error(lifecycleError);
    }
    throw error;
  }
}

export async function admitEnvironmentStartTask(
  environmentId: string,
  context: CommandContext,
  schedulePendingRename: (environmentId: string, context: CommandContext) => void,
  identity: ContainerMutationIdentity = {},
): Promise<{ task: Promise<EnvironmentSetupStartResult> }> {
  // Check both before and after the storage read. The first avoids needless I/O
  // for a delete already admitted in this process; the second closes the
  // await-sized race and enforces a tombstone recovered from persistent state.
  assertEnvironmentNotDeleting(environmentId);
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  assertEnvironmentDeletionNotRequested(environment, environmentId);
  assertEnvironmentNotDeleting(environmentId);

  const existing = environmentStartTasks.get(environmentId);
  if (existing) return { task: existing };

  const task = enqueueEnvironmentLifecycleOperation(environmentId, context, () =>
    startEnvironmentOnce(environmentId, context, schedulePendingRename, identity),
  ).finally(() => {
    if (environmentStartTasks.get(environmentId) === task) {
      environmentStartTasks.delete(environmentId);
    }
  });
  environmentStartTasks.set(environmentId, task);
  return { task };
}

/**
 * Serializes all resource-changing lifecycle operations for one environment.
 *
 * The queue tail always settles successfully so one failed operation cannot
 * poison retries. Callers still receive the original result/rejection.
 */
export function enqueueEnvironmentLifecycleOperation<T>(
  environmentId: string,
  context: CommandContext,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = environmentLifecycleOperations.get(environmentId) ?? Promise.resolve();
  const result = context.environmentLifecycleTasks.admit(() => previous.then(operation, operation));
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  environmentLifecycleOperations.set(environmentId, tail);
  void tail.finally(() => {
    if (environmentLifecycleOperations.get(environmentId) === tail) {
      environmentLifecycleOperations.delete(environmentId);
    }
  });
  return result;
}

/**
 * Once a conflicting operation has been admitted, a later start must queue
 * behind it instead of joining an earlier start that will be stopped/deleted.
 */
export function invalidateEnvironmentStartDedupe(environmentId: string): void {
  environmentStartTasks.delete(environmentId);
}

export async function stopEnvironmentOnce(
  environmentId: string,
  context: CommandContext,
  invalidateDiscovery: (environmentId: string) => void,
  identity: ContainerMutationIdentity = {},
): Promise<void> {
  const { storage } = context;
  const environment = await storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  await stopEnvironmentReviewValidation(environmentId, context);
  await stopEnvironmentExecWorkers(environmentId, context);
  // Discovery runs inside the environment, so its cached result stops being
  // meaningful the moment the environment does.
  invalidateDiscovery(environment.id);
  // The previous failure is cleared with the outcome, not ahead of it: a
  // `docker stop` that throws would otherwise erase the explanation the user is
  // reading and leave the environment in `error` with nothing to show.
  //
  // A stopped environment cannot honour a post-setup agent launch, and the
  // renderer cannot clear the intent for an environment it no longer mounts.
  // Revoke preview access before the target disappears so a host port Docker
  // later reuses can never inherit this environment's authorization.
  context.previews?.registry.beforeEnvironmentTargetChange(environment.id);
  if (environment.containerId) {
    const containerId = environment.containerId;
    await assertDockerContainerOwned(containerId, context);
    const outcome = await runContainerOperation(
      context,
      environment.id,
      "stop",
      identity,
      async (operation) => {
        const runtime = currentRuntimeIdentity(environment, context);
        const capabilities = await imageCapabilities(runtime?.imageId, context);
        let drain: DrainResult | null = null;
        if (capabilities?.["graceful-shutdown"]) {
          // Persist the fence before draining: new bridges, terminals and
          // setup are refused, and every observer sees "draining" rather than
          // a running environment that is about to vanish.
          await advanceContainerOperation(context, environment.id, operation.operationId, {
            phase: "draining",
            boot: { phase: "draining" },
          });
          drain = await withEnvironmentDraining(environment.id, containerId, () =>
            drainContainerProcesses(containerId),
          );
        }
        await advanceContainerOperation(context, environment.id, operation.operationId, {
          phase: "stopping",
          ...(drain ? { details: { signalled: drain.signalled, remaining: drain.remaining } } : {}),
        });
        await runCommand("docker", ["stop", containerId], { timeoutMs: 60_000 });
        // A forced stop is recorded as such, never as a graceful drain: either
        // Docker had to SIGKILL PID 1, or workload the drain could not stop
        // was killed by the container going down.
        const forced = capabilities?.["graceful-shutdown"]
          ? (drain?.remaining ?? 0) > 0 || (await containerStopWasForced(containerId)) === true
          : null;
        await advanceContainerOperation(context, environment.id, operation.operationId, {
          boot: { phase: "stopped" },
          ...(forced === null ? {} : { details: { forced } }),
          environment: {
            status: "stopped",
            lifecycleError: null,
            ...clearPendingAgentLaunchUpdates(),
          },
        });
      },
      { source: currentRuntimeIdentity(environment, context) },
    );
    if ("replayed" in outcome) return;
    shutdownClaudeStatePolling(containerId);
    invalidatePendingDiffStatsSync();
    diffStatsService.pause(environment.id);
    invalidatePendingPrMonitorSync();
    prMonitorService.pause(environment.id);
    return;
  }

  // A stopped local environment must not keep its bridge process trees alive.
  // Record partial progress even when one bridge refuses to terminate.
  let stopError: unknown;
  if (environment.worktreePath) {
    try {
      await enqueueLocalServerEnvironmentOperation(environment.id, () =>
        stopLocalServersForEnvironmentUnlocked(environment.id, context),
      );
    } catch (error) {
      stopError = error;
    }
  }
  await storage.updateEnvironment(environment.id, {
    status: "stopped",
    ...(stopError ? {} : { lifecycleError: null }),
    ...clearPendingAgentLaunchUpdates(),
  });
  if (stopError) throw stopError;
}

export function stopEnvironmentTask(
  environmentId: string,
  context: CommandContext,
  invalidateDiscovery: (environmentId: string) => void,
  identity: ContainerMutationIdentity = {},
): Promise<void> {
  invalidateEnvironmentStartDedupe(environmentId);
  return enqueueEnvironmentLifecycleOperation(environmentId, context, () =>
    stopEnvironmentOnce(environmentId, context, invalidateDiscovery, identity),
  );
}

/**
 * Fields that describe the workspace a discarded runtime had prepared. A fresh
 * runtime starts from an empty `/workspace`, so none of them may survive: a
 * retained `setupScriptsComplete` would make setup short-circuit and a retained
 * `createdFromCommit` would skip the clone, handing the user a container with
 * no checkout. `delegationBaseCommit` is deliberately absent — it is the
 * immutable intent the new checkout must be reconciled to.
 */
export function discardedRuntimeSetupUpdates(): Partial<Environment> {
  return {
    setupScriptsComplete: false,
    setupPhase: "pending",
    setupOverride: false,
    setupSessionId: undefined,
    setupStartedAt: undefined,
    setupCompletedAt: undefined,
    createdFromCommit: undefined,
    hostEntryPort: undefined,
  };
}

/**
 * Removes one runtime and reports whether Docker confirmed it is gone.
 *
 * `docker rm -f` succeeds for an absent container on current engines and fails
 * with "no such container" on older ones; both are confirmed absence. Every
 * other failure — a refusal, a timeout, an unreachable daemon — leaves the
 * deterministic container name possibly still reserved, so the caller must keep
 * the reference rather than advancing to a create that would collide with it.
 */
export async function removeContainerConfirmingAbsence(containerId: string): Promise<void> {
  try {
    await runCommand("docker", ["rm", "-f", containerId], { timeoutMs: 60_000 });
  } catch (error) {
    if (isMissingDockerObjectError(error)) return;
    throw error;
  }
}

function containerLifecycleError(code: ContainerLifecycleErrorCode, message: string): Error {
  return new Error(formatContainerLifecycleError(code, message));
}

export async function recreateEnvironmentOnce(
  request: RecreateEnvironmentRequest,
  context: CommandContext,
  schedulePendingRename: (environmentId: string, context: CommandContext) => void,
  invalidateDiscovery: (environmentId: string) => void,
): Promise<EnvironmentSetupStartResult | undefined> {
  // No agent prompt reaches this environment while its runtime is replaced.
  return withEnvironmentReplacement(request.environmentId, () =>
    recreateEnvironmentOnceUnfenced(request, context, schedulePendingRename, invalidateDiscovery),
  );
}

async function recreateEnvironmentOnceUnfenced(
  request: RecreateEnvironmentRequest,
  context: CommandContext,
  schedulePendingRename: (environmentId: string, context: CommandContext) => void,
  invalidateDiscovery: (environmentId: string) => void,
): Promise<EnvironmentSetupStartResult | undefined> {
  const environment = await context.storage.getEnvironment(request.environmentId);
  if (!environment?.containerId) return;
  // Re-read under the lifecycle queue: the request may have waited behind a
  // start/recreate that replaced the runtime the user reviewed.
  assertEnvironmentNotDeleting(environment.id);
  assertEnvironmentDeletionNotRequested(environment, environment.id);
  if (request.intent !== "discard" && request.expectedContainerId) {
    // A preserving rebuild copies the workspace and provider state into a new
    // storage set and commits the new runtime only after it verified. Any
    // failure before the commit leaves the original authoritative.
    const wasRunning = environment.status === "running";
    invalidateEnvironmentStartDedupe(environment.id);
    try {
      await replaceRuntimePreservingState(
        {
          ...request,
          environmentId: environment.id,
          expectedContainerId: request.expectedContainerId,
          ...(request.allowUnknownCapacity ? { allowUnknownCapacity: true } : {}),
        },
        context,
      );
    } catch (error) {
      const after = await context.storage.getEnvironment(environment.id);
      if (
        wasRunning &&
        after?.containerId === environment.containerId &&
        after.status !== "running"
      ) {
        await startEnvironmentOnce(environment.id, context, schedulePendingRename).catch(
          (restart) =>
            logEnvironmentLifecycleFailure("rebuild (restoring original)", environment.id, restart),
        );
      }
      throw error;
    }
    invalidateDiscovery(environment.id);
    cancelOpenCodeAgentToolsConfiguration(`container:${environment.containerId}`);
    cleanupEnvironmentSetupState(environment.id);
    // Setup belongs to a runtime: the new one runs it again (the preserved
    // checkout is kept, so the clone step is skipped). The workspace itself,
    // and the commit it was created from, carry over unchanged.
    const { createdFromCommit: _kept, ...setupReset } = discardedRuntimeSetupUpdates();
    await context.storage.updateEnvironment(environment.id, setupReset);
    return startEnvironmentOnce(environment.id, context, schedulePendingRename);
  }
  if (request.intent !== "discard") {
    // A preserving request that did not bind the runtime it reviewed cannot
    // be replayed safely against whichever container is current now.
    throw containerLifecycleError(
      "preservation-required",
      "Rebuilding keeps this environment's files only when it names the container that was " +
        "reviewed. Review the environment and rebuild it, or explicitly reset the container.",
    );
  }
  if (request.expectedContainerId !== environment.containerId) {
    throw containerLifecycleError(
      "runtime-changed",
      "The container changed after it was reviewed. Review the environment again before resetting it.",
    );
  }
  const containerId = environment.containerId;
  await assertDockerContainerOwned(containerId, context);
  const keepCopy = request.keepRecoveryCopy === true;
  const parsedRecord = parseContainerLifecycle(environment.containerLifecycle);
  if (keepCopy && parsedRecord.supported) assertRecoveryCapacity(parsedRecord.record);
  const sourceRuntime = currentRuntimeIdentity(environment, context);
  const admission = await beginContainerOperation(context, environment.id, "discard", {
    ...request,
    source: sourceRuntime,
    ...(keepCopy ? { details: { keepRecoveryCopy: true } } : {}),
  });
  if (admission.kind === "replayed") return;
  const { operationId } = admission.operation;
  try {
    // Commands running in the container are cancelled (and recorded as such)
    // before the container they run in is removed.
    await stopEnvironmentReviewValidation(environment.id, context);
    await stopEnvironmentExecWorkers(environment.id, context);
    invalidateDiscovery(environment.id);
    context.previews?.registry.beforeEnvironmentTargetChange(environment.id);
    shutdownClaudeStatePolling(containerId);
    cancelOpenCodeAgentToolsConfiguration(`container:${containerId}`);
    await advanceContainerOperation(context, environment.id, operationId, { phase: "removing" });
  } catch (error) {
    await completeContainerOperation(context, environment.id, operationId, "failed", {
      failureCode: operationFailureCode(error),
    }).catch(() => undefined);
    throw error;
  }
  if (keepCopy && parsedRecord.supported) {
    // Reset keeping a copy: the runtime is stopped, not removed, and it and
    // its storage set become a recovery copy in the same commit that starts
    // a new workspace generation. Nothing is deleted.
    try {
      await quiesceRuntime(environment.id, containerId, sourceRuntime?.imageId, context);
    } catch (error) {
      await completeContainerOperation(context, environment.id, operationId, "failed", {
        failureCode: operationFailureCode(error),
      }).catch(() => undefined);
      throw error;
    }
    containerGitFetchPolicy.forgetContainer(containerId);
    await context.storage.clearBackendTerminalSessionIds?.(environment.id);
    cleanupEnvironmentSetupState(environment.id);
    const storage = parsedRecord.record.storage;
    await completeContainerOperation(context, environment.id, operationId, "succeeded", {
      phase: "retained",
      runtime: null,
      storage: { format: "legacy-layer", workspaceGeneration: storage.workspaceGeneration + 1 },
      ...retainedEntriesFor(sourceRuntime, storage, "workspace-reset", operationId),
      boot: { phase: "stopped" },
      environment: {
        containerId: null,
        status: "stopped",
        lifecycleError: null,
        ...discardedRuntimeSetupUpdates(),
        ...clearPendingAgentLaunchUpdates(),
      },
    });
    return startEnvironmentOnce(environment.id, context, schedulePendingRename);
  }
  try {
    await removeContainerConfirmingAbsence(containerId);
  } catch (error) {
    // The old name may still be reserved by the daemon, and the container may
    // hold the only copy of the user's work. Keep the reference and surface
    // the failure instead of creating a replacement that would either collide
    // with it or orphan it.
    logEnvironmentLifecycleFailure("recreate (container removal)", environment.id, error);
    await completeContainerOperation(context, environment.id, operationId, "failed", {
      failureCode: "removal-failed",
      environment: { lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.containerRemovalFailed },
    }).catch(() => undefined);
    throw containerLifecycleError(
      "removal-failed",
      "Docker did not remove the container, so it was kept. Retry once Docker is healthy.",
    );
  }
  containerGitFetchPolicy.forgetContainer(containerId);
  // Terminals and setup state belong to the removed runtime. A pane-carried
  // PTY id or a retained setup buffer must not attach to the replacement.
  await context.storage.clearBackendTerminalSessionIds?.(environment.id);
  cleanupEnvironmentSetupState(environment.id);
  // Discard deletes the workspace too. Persistent volumes go with it; one that
  // will not remove stays referenced as a retained copy rather than orphaned.
  // The next start begins a new workspace generation on a new storage set.
  const discardedStorage = await discardPersistentStorage(context, environment.id, operationId);
  await completeContainerOperation(context, environment.id, operationId, "succeeded", {
    phase: "removed",
    runtime: null,
    ...(discardedStorage ? { storage: discardedStorage } : {}),
    environment: {
      containerId: null,
      status: "stopped",
      lifecycleError: null,
      ...discardedRuntimeSetupUpdates(),
      ...clearPendingAgentLaunchUpdates(),
    },
  });
  return startEnvironmentOnce(environment.id, context, schedulePendingRename);
}

/**
 * Restores a recovery copy (keeping the current state as another copy) and
 * starts the environment on it.
 */
export function restoreRecoveryCopyTask(
  request: RestoreCopyRequest,
  context: CommandContext,
  schedulePendingRename: (environmentId: string, context: CommandContext) => void,
  invalidateDiscovery: (environmentId: string) => void,
): Promise<EnvironmentSetupStartResult | undefined> {
  return enqueueEnvironmentLifecycleOperation(request.environmentId, context, async () => {
    const environment = await context.storage.getEnvironment(request.environmentId);
    if (!environment) throw new Error(`Environment not found: ${request.environmentId}`);
    assertEnvironmentNotDeleting(environment.id);
    assertEnvironmentDeletionNotRequested(environment, environment.id);
    invalidateEnvironmentStartDedupe(environment.id);
    const restored = await restoreRecoveryCopy(request, context);
    if (!restored) return undefined;
    invalidateDiscovery(environment.id);
    if (environment.containerId) {
      containerGitFetchPolicy.forgetContainer(environment.containerId);
      cancelOpenCodeAgentToolsConfiguration(`container:${environment.containerId}`);
    }
    cleanupEnvironmentSetupState(environment.id);
    const { createdFromCommit: _kept, ...setupReset } = discardedRuntimeSetupUpdates();
    await context.storage.updateEnvironment(environment.id, setupReset);
    return startEnvironmentOnce(environment.id, context, schedulePendingRename);
  });
}

/** Deletes one recovery copy under the lifecycle queue. */
export function discardRecoveryCopyTask(
  request: RecoveryCopyRequest,
  context: CommandContext,
): Promise<DiscardCopyResult | undefined> {
  return enqueueEnvironmentLifecycleOperation(request.environmentId, context, async () => {
    const environment = await context.storage.getEnvironment(request.environmentId);
    if (!environment) throw new Error(`Environment not found: ${request.environmentId}`);
    assertEnvironmentNotDeleting(environment.id);
    assertEnvironmentDeletionNotRequested(environment, environment.id);
    return discardRecoveryCopy(request, context);
  });
}

export function recreateEnvironmentTask(
  request: RecreateEnvironmentRequest,
  context: CommandContext,
  schedulePendingRename: (environmentId: string, context: CommandContext) => void,
  invalidateDiscovery: (environmentId: string) => void,
): Promise<EnvironmentSetupStartResult | undefined> {
  // Only a discard replaces the runtime here; a preserving rebuild detaches
  // start dedupe once it is admitted. A refused request must not detach a
  // later start from one already in flight.
  if (request.intent === "discard") invalidateEnvironmentStartDedupe(request.environmentId);
  return enqueueEnvironmentLifecycleOperation(request.environmentId, context, () =>
    recreateEnvironmentOnce(request, context, schedulePendingRename, invalidateDiscovery),
  );
}

export async function runEnvironmentSetupNow(
  environmentId: string,
  context: CommandContext,
): Promise<Environment> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  if (environment.setupScriptsComplete) return environment;

  const existingTask = environmentSetupTasks.get(environmentId);
  if (existingTask) return existingTask;

  const result = await startEnvironmentSetup(environment, context);
  if (!result.setupStarted) return result.environment;

  const task = environmentSetupTasks.get(environmentId);
  if (!task) throw new Error(`Setup task was not started: ${environmentId}`);
  return task;
}

export async function createLocalWorktree(
  projectPath: string,
  projectName: string,
  branch: string,
  baseBranch?: string,
  filesToCopy?: string[],
  worktreeBaseDir?: string,
): Promise<{ path: string; branch: string; createdFromCommit: string }> {
  const baseDir = worktreeBaseDir ?? getWorktreeBaseDir();
  await fs.mkdir(baseDir, { recursive: true });
  const baseSlug = sanitizeBranchName(branch);
  const requestedBase = baseBranch?.trim() || "main";
  const startPoint =
    /^[0-9a-f]{40}$/i.test(requestedBase) && (await gitRefExists(projectPath, requestedBase))
      ? requestedBase
      : await resolveRemoteWorktreeStartPoint(projectPath, requestedBase);
  const gitBranchExists = await createGitBranchCollisionChecker({
    baseBranch: baseSlug,
    projectPath,
  });
  const finalBranch = await allocateGitBranchName(baseSlug, async (candidate) => {
    const candidatePath = path.join(
      baseDir,
      `${sanitizeEnvironmentName(projectName)}-${candidate}`,
    );
    return (await pathExists(candidatePath)) || (await gitBranchExists(candidate));
  });
  const worktreePath = path.join(baseDir, `${sanitizeEnvironmentName(projectName)}-${finalBranch}`);

  // A branch created directly from origin/<base> otherwise inherits that base as
  // its upstream (usually origin/main), which is what makes a plain `git push`
  // target the base branch instead of publishing the environment branch.
  const args = [
    "-C",
    projectPath,
    "worktree",
    "add",
    "--no-track",
    "-b",
    finalBranch,
    worktreePath,
    startPoint,
  ];
  await runCommand("git", args, { timeoutMs: 120_000 });

  try {
    await configureSameNamedOriginPush(worktreePath);
    const createdFromCommit = await readLocalHeadCommit(worktreePath);

    await fs.mkdir(path.join(worktreePath, ".orkestrator"), { recursive: true });
    await addLocalWorkspaceArtifactsToGitExclude(worktreePath);
    await enableGitScanCaches(worktreePath);

    for (const envFile of [".env", ".env.local"]) {
      const source = path.join(projectPath, envFile);
      const destination = path.join(worktreePath, envFile);
      if ((await pathExists(source)) && !(await pathExists(destination))) {
        await fs.copyFile(source, destination);
      }
    }

    await copyConfiguredProjectFilesToDirectory(projectPath, worktreePath, filesToCopy);

    return { path: worktreePath, branch: finalBranch, createdFromCommit };
  } catch (error) {
    await cleanupFailedLocalWorktree(projectPath, worktreePath, finalBranch);
    throw error;
  }
}

export async function removeLocalWorktree(
  projectPath: string,
  worktreePath: string,
): Promise<void> {
  await runCommand("git", ["-C", projectPath, "worktree", "remove", "--force", worktreePath], {
    timeoutMs: 120_000,
  }).catch(async () => {
    await fs.rm(worktreePath, { recursive: true, force: true });
    await runCommand("git", ["-C", projectPath, "worktree", "prune"], {
      timeoutMs: 30_000,
    }).catch(() => undefined);
  });
}

export async function deleteMergedEnvironmentRemoteBranch(environment: Environment): Promise<void> {
  if (environment.prState !== "merged" || !environment.prUrl) return;

  if (environment.environmentType === "local") {
    if (!environment.worktreePath) return;
    await deletePullRequestHeadBranchViaGitHubApi(
      environment.prUrl,
      createLocalGhRunner(environment.worktreePath),
    );
    return;
  }

  if (environment.containerId && environment.status === "running") {
    await deletePullRequestHeadBranchViaGitHubApi(
      environment.prUrl,
      createContainerGhRunner(environment.containerId),
    );
  }
}

export async function cleanupFailedLocalWorktree(
  projectPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await runCommand("git", ["-C", projectPath, "worktree", "remove", "--force", worktreePath], {
    timeoutMs: 120_000,
  }).catch(async () => {
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await runCommand("git", ["-C", projectPath, "worktree", "prune"], { timeoutMs: 30_000 }).catch(
      () => undefined,
    );
  });

  const refName = validateGitRefName(branch, "environment branch");
  await runCommand("git", ["-C", projectPath, "branch", "-D", refName], {
    timeoutMs: 30_000,
  }).catch(() => undefined);
}

export function parseIpTokens(output: string): string[] {
  return output
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => isIP(value));
}

/**
 * Repair persisted container host routing before handing an agent a backend
 * tools URL. Linux Engine needs a host-gateway alias, while Docker Desktop must
 * use its built-in DNS rather than an explicit Linux bridge-gateway override.
 */
export async function ensureContainerAgentToolsHost(containerId: string): Promise<void> {
  let existing = await dockerExec(
    containerId,
    `getent hosts ${CONTAINER_AGENT_TOOLS_HOST} 2>/dev/null || true`,
    10_000,
  );

  // Docker Desktop's gateway hostname is a reliable in-container signal that
  // its special DNS is available. Older Orkestrator containers were created
  // with an explicit host-gateway entry even on Desktop; remove that entry so
  // host.docker.internal falls back to Desktop DNS instead of the unreachable
  // Linux VM bridge gateway.
  const desktopGateway = await dockerExec(
    containerId,
    `getent hosts ${DOCKER_DESKTOP_GATEWAY_HOST} 2>/dev/null || true`,
    10_000,
  );
  if (parseIpTokens(desktopGateway).length > 0) {
    const explicitHostEntry = await dockerExec(
      containerId,
      `grep -E '^[^#]*[[:space:]]${CONTAINER_AGENT_TOOLS_HOST.replaceAll(".", "\\.")}([[:space:]]|$)' /etc/hosts 2>/dev/null || true`,
      10_000,
    );
    if (explicitHostEntry.trim()) {
      const repairHosts = `
        set -eu
        hosts_tmp="/tmp/orkestrator-hosts.$$"
        trap 'rm -f "$hosts_tmp"' EXIT
        awk '$2 != "${CONTAINER_AGENT_TOOLS_HOST}"' /etc/hosts > "$hosts_tmp"
        cat "$hosts_tmp" > /etc/hosts
      `;
      await runCommand(
        "docker",
        ["exec", "--user", "root", containerId, "bash", "-lc", repairHosts],
        { timeoutMs: 10_000 },
      );
      existing = await dockerExec(
        containerId,
        `getent hosts ${CONTAINER_AGENT_TOOLS_HOST} 2>/dev/null || true`,
        10_000,
      );
    }
    if (parseIpTokens(existing).length === 0) {
      throw new Error(
        `Docker Desktop did not resolve ${CONTAINER_AGENT_TOOLS_HOST} for container ${containerId}`,
      );
    }
    return;
  }

  const { stdout } = await runCommand(
    "docker",
    [
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{println .Gateway}}{{end}}",
      containerId,
    ],
    { timeoutMs: 10_000 },
  );
  const gateway = parseIpTokens(stdout)[0];
  if (!gateway) {
    throw new Error(`Could not determine the Docker host gateway for container ${containerId}`);
  }
  if (parseIpTokens(existing).includes(gateway)) return;

  const repairHosts = `
    set -eu
    gateway="$1"
    hosts_tmp="/tmp/orkestrator-hosts.$$"
    trap 'rm -f "$hosts_tmp"' EXIT
    awk '$2 != "${CONTAINER_AGENT_TOOLS_HOST}"' /etc/hosts > "$hosts_tmp"
    printf '%s\\t%s\\n' "$gateway" "${CONTAINER_AGENT_TOOLS_HOST}" >> "$hosts_tmp"
    cat "$hosts_tmp" > /etc/hosts
  `;
  await runCommand(
    "docker",
    [
      "exec",
      "--user",
      "root",
      containerId,
      "bash",
      "-lc",
      repairHosts,
      "orkestrator-host-repair",
      gateway,
    ],
    { timeoutMs: 10_000 },
  );
}

export async function resolveContainerAgentToolConnection(
  context: CommandContext,
  containerId: string,
): Promise<AgentToolConnection | undefined> {
  if (!context.agentTools) return undefined;
  const environment = findEnvironmentByContainerId(
    await context.storage.loadEnvironments(),
    containerId,
  );
  if (!environment) return undefined;
  await ensureContainerAgentToolsHost(containerId);
  await ensureContainerHostServicePorts(containerId, context.agentTools.servicePort?.() ?? null);
  return context.agentTools.connection(environment.id, environment.projectId, "container");
}

/**
 * A policy-2 container allows exactly the backend's service port toward the
 * host. The port is fixed at creation, but a backend restart may listen on a
 * different one; the durable in-container policy is updated to match before
 * a tools URL is handed out. Legacy (policy 1) containers are left alone.
 */
export async function ensureContainerHostServicePorts(
  containerId: string,
  servicePort: number | null,
): Promise<void> {
  if (!servicePort) return;
  const current = await runCommand(
    "docker",
    [
      "exec",
      containerId,
      "sh",
      "-c",
      "[ -f /etc/orkestrator/network-policy ] && cat /etc/orkestrator/network-policy /etc/orkestrator/host-service-ports || true",
    ],
    { timeoutMs: 10_000 },
  ).catch(() => null);
  if (!current) return;
  const [policy, ports = ""] = current.stdout.trim().split("\n");
  if (policy?.trim() !== "2") return;
  if (ports.split(",").includes(String(servicePort))) return;
  await runCommand(
    "docker",
    [
      "exec",
      "--user",
      "root",
      containerId,
      "/usr/local/bin/update-firewall.sh",
      "--host-ports",
      String(servicePort),
    ],
    { timeoutMs: 20_000 },
  );
}
