import {
  isLaunchableTerminalJobTabType,
  parseTerminalOpenCodeLaunchCommand,
} from "@orkestrator/protocol/terminal-agent-launch";
import { resolveManagedBinary } from "./commands-agent-support.js";
import {
  resolveOpenCode2TerminalCommand,
  containerOpenCodeTerminalCommand,
  writeOpenCode2HostConfig,
} from "./opencode2/index.js";
import { canonicalWorktreePath } from "@orkestrator/protocol/node/worktree-paths";
import { isEnvironmentReadyForAgents } from "@orkestrator/protocol/environment-readiness";
import {
  bootstrapTerminalSessionCommand,
  closeLocalTerminalSessionCommand,
  createLocalTerminalSessionCommand,
  createTerminalSessionCommand,
  detachTerminalCommand,
  getTerminalHistoryPageCommand,
  getTerminalOutputBufferCommand,
  getTerminalOutputSnapshotCommand,
  getTerminalSessionCommand,
  getTerminalStateSnapshotCommand,
  launchTerminalJobCommand,
  listTerminalSessionsCommand,
  localTerminalResizeCommand,
  localTerminalWriteCommand,
  startLocalTerminalSessionCommand,
  startTerminalSessionCommand,
  terminalResizeCommand,
  terminalSnapshotAppliedCommand,
  terminalSnapshotFailedCommand,
  terminalWriteCommand,
} from "@orkestrator/protocol/contract/domains/terminals";
import {
  checkContainerWorkspacePathsCommand,
  copyExternalFileCommand,
  createContainerFolderCommand,
  createLocalFolderCommand,
  deleteContainerAnnotationEvidenceCommand,
  deleteContainerFileCommand,
  deleteLocalFileCommand,
  getFileSubtreeCommand,
  getFileTreeCommand,
  getLocalFileSubtreeCommand,
  getLocalFileTreeCommand,
  getWorktreeSnapshotRevisionsCommand,
  moveContainerFileCommand,
  moveLocalFileCommand,
  readContainerFileBase64Command,
  readContainerFileCommand,
  readEnvironmentFileBase64Command,
  readFileAtBranchCommand,
  readFileBase64Command,
  readLocalFileAtBranchCommand,
  readLocalFileCommand,
  renameContainerFileCommand,
  renameLocalFileCommand,
  revertContainerFileCommand,
  revertLocalFileCommand,
  writeContainerFileCommand,
  writeInitialPromptAttachmentsCommand,
  writeLocalFileCommand,
  type FileTreeNode,
} from "@orkestrator/protocol/contract/domains/files";
import type { CommandContext } from "./commands-context.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import type { Environment } from "./models.js";
import { assertContainerNotDraining } from "./container-readiness.js";
import { gitDockerScanPool } from "./git-docker-scan-pool.js";
import { createHash, randomUUID } from "node:crypto";
import { WEB_ANNOTATION_LIMITS } from "@orkestrator/protocol/web-annotations";
import {
  getEnvironmentCommitAncestryCommand,
  getEnvironmentDiffStatsCommand,
  getEnvironmentUncommittedPathsCommand,
  getGitStatusCommand,
  getLocalGitStatusCommand,
} from "@orkestrator/protocol/contract/domains/git";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  MAX_BASE64_PAYLOAD_BYTES,
  assertBase64PayloadWithinLimit,
  base64DecodedByteLength,
  MAX_BINARY_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  MAX_TEXT_FILE_SIZE_LABEL,
  removeConfinedDirectory,
  validateRelativeFilePath,
  workspaceFilePath,
} from "./path-safety.js";
import {
  CONTAINER_EVIDENCE_REMOVER,
  CONTAINER_EVIDENCE_WRITER,
  isAnnotationEvidencePath,
  MAX_WORKSPACE_PATH_CHECKS,
  runContainerEvidenceScript,
  runContainerPathCheck,
} from "./web-annotations/index.js";
import { isSafeRelativePath } from "@orkestrator/protocol/web-annotations-validation";
import { parseFileWritePrecondition } from "@orkestrator/protocol/file-write-precondition";
import {
  CONTAINER_WRITE_CONFLICT_EXIT,
  assertLocalFileUnchanged,
  containerFileWriteScript,
  fileWriteConflictError,
  serializeFileWrite,
} from "./file-write-precondition.js";
import path from "node:path";
import {
  pathExists,
  readFileBase64,
  readTextFile,
  inferLanguage,
  assertEditorTextFileSize,
  decodeEditorTextFile,
  runCommand,
  writeFileBase64,
  CommandFailedError,
} from "./shell.js";
import { runContainerWrite } from "./container-write.js";
import {
  INITIAL_PROMPT_STAGING_DIRECTORY,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "./prompt-attachments.js";
import type { EnvironmentDiffStatsSnapshot } from "@orkestrator/protocol/diff-stats";
import type { EnvironmentDiffStatsSnapshotOutcome } from "@orkestrator/protocol/diff-stats";
import type {
  WorktreeReadStamp,
  WorktreeSnapshotRevisionsOutcome,
  WorktreeSnapshotRevisionsSnapshot,
} from "@orkestrator/protocol/worktree-snapshots";
import {
  parseViewSnapshotRequest,
  resolveViewSnapshotOutcome,
} from "@orkestrator/protocol/view-sync";
import {
  CONTAINER_INTERACTIVE_SHELL_COMMAND,
  CONTAINER_SAFE_BASE64_READER,
  CONTAINER_TERMINAL_SESSION_ENV,
  containerTerminalUserArgs,
  asString,
  asRecord,
  asOptionalString,
  asBoolean,
  asRequiredBoolean,
  asNumber,
  asTerminalDimension,
  asNonBlankString,
  quoteShell,
  validateGitRefName,
  envWithManagedBinaries,
  resolveBunBinary,
  createEnvironmentCommandRunner,
  parseGitPorcelainPaths,
  findEnvironmentByContainerId,
  logSetupTerminal,
  resolveLocalShellPath,
  stableTerminalKey,
  assertEnvironmentDeletionNotRequested,
  spawnTerminalProcess,
  isSetupTerminalSessionId,
  isTerminalSessionAttachable,
  dockerExec,
  validateWorkspaceMutationPath,
  pruneLocalInitialPromptBatches,
  containerPruneInitialPromptBatchesCommand,
  CONTAINER_PINNED_ATTACHMENT_WRITE,
  containerRemoveInitialPromptBatchCommand,
  writeConfinedLocalArtifact,
  revertLocalFile,
  deleteLocalFile,
  moveLocalFile,
  renameLocalFile,
  copyExternalFileToLocalWorkspace,
  createLocalFolder,
  requireLocalMutationEnvironment,
  requireContainerMutationEnvironment,
  revertContainerFile,
  containerDeleteFileCommand,
  resolveWorkspaceFileMove,
  resolveWorkspaceFileRename,
  resolveWorkspaceExternalFileCopy,
  resolveWorkspaceFolderCreate,
  containerMoveFileCommand,
  containerCreateFolderCommand,
  readLocalFileAtBranch,
  buildFileSubtree,
  validateFileTreeDirectory,
  CONTAINER_FILE_TREE_LISTER,
  MAX_FILE_TREE_NODES,
  parseContainerFileSubtree,
} from "./commands-helpers.js";
import { conditionalSnapshot } from "./commands-terminal.js";
import type { GitFileChange } from "./commands-helpers.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { readableHostFileRoots } from "./readable-host-roots.js";
import { containerGitBlobReadCommand, decodeGitBatchOutput } from "./git-blob-read.js";
import {
  parseReviewWorktreeFingerprint,
  REVIEW_WORKTREE_FINGERPRINT_TIMEOUT_MS,
  REVIEW_WORKTREE_PROBE_TIMEOUT_MS,
  reviewWorktreeProbeArgs,
} from "./review-worktree-fingerprint.js";
import { KeyedTrailingFlight } from "./keyed-trailing-flight.js";
import type { TerminalHistory } from "./terminal-history.js";
import {
  activeAgentAccountShellEnvironment,
  stripInheritedAgentCredentials,
} from "./agent-accounts-active.js";
import { applyActiveAgentAccountsForContainerTerminal } from "./agent-accounts-containers.js";
import { newContainerTerminalToken } from "./container-terminal-shell.js";

/**
 * Starts a container terminal's `docker exec -it` shell, marked with a fresh
 * token so that closing the PTY can end the shell in the container as well
 * (`container-terminal-shell.ts`). An already running PTY is left as it is.
 */
/** Resolve even legacy terminals that were opened with only a container id. */
async function assertContainerCheckoutAvailable(
  containerId: string,
  context: CommandContext,
): Promise<void> {
  const environments = await context.storage.loadEnvironments();
  for (const environment of environments) {
    const owned = environment.containerId;
    if (owned && (owned.startsWith(containerId) || containerId.startsWith(owned)))
      context.runtime.environments.fence.assertNotMoving(environment.id);
  }
}

function spawnContainerTerminal(
  id: string,
  config: { containerId: string; cols: number; rows: number; user?: string },
  context: CommandContext,
  hooks?: { onData?: (data: string) => void; onExit?: () => void },
): void {
  if (context.runtime.terminals.hasProcess(id)) return;
  const token = newContainerTerminalToken();
  const dockerArgs = ["exec", "-it", "--env", `${CONTAINER_TERMINAL_SESSION_ENV}=${token}`];
  dockerArgs.push(...containerTerminalUserArgs(config.user));
  dockerArgs.push(config.containerId, "bash", "-lc", CONTAINER_INTERACTIVE_SHELL_COMMAND);
  spawnTerminalProcess(id, "docker", dockerArgs, config, context, hooks);
  context.runtime.terminals.recordContainerShell(id, {
    containerId: config.containerId,
    ...(config.user ? { user: config.user } : {}),
    token,
  });
}

/**
 * The registered local environment whose worktree `worktreePath` names.
 *
 * `read_local_file` and `write_local_file` take a client-supplied root and
 * confine the relative path beneath it. The root itself must therefore be one
 * Orkestrator owns: a directory no environment is registered at is refused,
 * so a client cannot turn either command on an arbitrary host directory.
 */
async function requireRegisteredLocalRoot(
  context: CommandContext,
  worktreePath: string,
): Promise<{ environment: Environment & { worktreePath: string }; canonical: string }> {
  const canonical = canonicalWorktreePath(worktreePath);
  const environment = (await context.storage.loadEnvironments()).find(
    (candidate) =>
      candidate.environmentType === "local" &&
      !!candidate.worktreePath &&
      canonicalWorktreePath(candidate.worktreePath) === canonical,
  );
  if (!environment?.worktreePath)
    throw new Error("The path is not the worktree of a registered local environment");
  return { environment: environment as Environment & { worktreePath: string }, canonical };
}

/** Hold shared-checkout admission across a home file mutation. */
async function withLocalFileMutation<T>(
  context: CommandContext,
  environmentId: string,
  action: (environment: Environment) => Promise<T>,
): Promise<T> {
  const releaseMutation = context.runtime.environments.fence.beginMutation(environmentId);
  let release: (() => void) | undefined;
  try {
    const stored = await context.storage.getEnvironment(environmentId);
    if (stored?.worktreeMove)
      throw new Error(
        "Move recovery is pending. Restart Orkestrator before editing this environment.",
      );
    release = stored?.projectHome
      ? await context.projectGit?.beginTurnAfterMergeSync(stored.projectId)
      : undefined;
    return await action(await requireLocalMutationEnvironment(context.storage, environmentId));
  } finally {
    release?.();
    releaseMutation();
  }
}

/**
 * Answers a file-list or tree read in the command's legacy shapes.
 *
 * Without `knownDigest` the raw array, exactly as before. With it, the
 * conditional `{ unchanged, digest, value? }` answer whose digest is the one
 * older clients already hold (`sha256(JSON.stringify(value))`), plus an
 * additive `view` stamp when a tracked owner served the read. The digest is
 * computed once per owner result, not once per read.
 */
function snapshotResponse<T>(
  kind: "file-list-read" | "file-tree-read",
  value: T,
  digest: string,
  knownDigest: unknown,
  view: WorktreeReadStamp | undefined,
): T | { unchanged: boolean; digest: string; value?: T; view?: WorktreeReadStamp } {
  if (knownDigest === undefined) return value;
  const unchanged = typeof knownDigest === "string" && knownDigest === digest;
  // An unchanged response still paid for whatever read produced it; the two
  // are counted apart so a small response is never mistaken for less work.
  recurringWorkMetrics.outcome(kind, unchanged ? "unchanged" : "changed");
  return {
    unchanged,
    digest,
    ...(unchanged ? {} : { value }),
    ...(view ? { view } : {}),
  };
}

function refreshRequested(value: unknown): boolean {
  return value === true;
}

function resizeTerminalHistoryBestEffort(
  history: TerminalHistory,
  sessionId: string,
  cols: number,
  rows: number,
): void {
  try {
    history.resize(sessionId, cols, rows);
  } catch {
    // History is an optional recovery surface. If its emulator rejects an
    // unusual geometry, release that collector without failing a PTY resize
    // that has already succeeded.
    void Promise.resolve()
      .then(() => history.dispose(sessionId))
      .catch(() => undefined);
  }
}

/**
 * One worktree probe at a time per environment and kind. A guard, a stage
 * start and a review fan-out can all ask at once, and on a slow or busy disk
 * concurrent `git status` walks of one checkout only slow each other down.
 * Process-wide on purpose: the worktree is shared by every backend that asks.
 */
const worktreeProbes = new KeyedTrailingFlight<string>();

export function registerTerminalCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  register(
    launchTerminalJobCommand,
    async (args, context) => {
      const environmentId = asNonBlankString(args.environmentId, "environmentId");
      const requestId = asNonBlankString(args.requestId, "requestId");
      if (requestId.length > 256) throw new Error("requestId must be at most 256 characters");
      const requestedTabId = asOptionalString(args.tabId)?.trim();
      if (requestedTabId && requestedTabId.length > 256) {
        throw new Error("tabId must be at most 256 characters");
      }
      const tabType = asNonBlankString(args.tabType, "tabType");
      if (tabType !== "claude-tmux" && !isLaunchableTerminalJobTabType(tabType)) {
        throw new Error("Terminal job tab type is invalid");
      }
      const title = asOptionalString(args.title)?.trim();
      if (title && title.length > 200) throw new Error("title must be at most 200 characters");
      // Omitting `data` opens a shell that runs nothing. Reconnect uses it to give
      // an existing launched tab a new shell once the backend that owned its old
      // one has restarted: the renderer must not create a PTY for these tabs
      // itself, and running the original command again is not what was asked.
      const data =
        tabType === "claude-tmux" || args.data === undefined
          ? undefined
          : asString(args.data, "data");
      if (data !== undefined && !data.trim()) throw new Error("data must not be blank");
      if (tabType !== "claude-tmux" && data === undefined && !requestedTabId) {
        throw new Error("data is required for a new terminal job");
      }
      if (data !== undefined && data.length > 500_000) {
        throw new Error("data must be at most 500000 characters");
      }
      const environment = await context.storage.getEnvironment(environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting") {
        throw new Error("Environment is being deleted");
      }
      if (!isEnvironmentReadyForAgents(environment)) {
        throw new Error("Environment is not running with setup complete");
      }
      if (
        tabType !== "claude-tmux" &&
        environment.environmentType !== "local" &&
        !environment.containerId
      ) {
        throw new Error("Environment container is unavailable");
      }

      const jobId = createHash("sha256")
        .update(environmentId)
        .update("\0")
        .update(requestId)
        .digest("hex")
        .slice(0, 24);
      const tabId = requestedTabId || `terminal-job-${jobId}`;
      await context.storage.ensureTerminalJobTab({
        environmentId,
        tabId,
        type: tabType,
        title,
        activate:
          args.activateTab === "setup-handoff" ? "setup-handoff" : args.activateTab === true,
        // A shell-only restart is for a tab that is already open. Checking for
        // it here, inside the serialized layout mutation and before any PTY is
        // created, means a restart that raced the user closing the tab fails
        // instead of putting the tab back.
        ...(tabType !== "claude-tmux" && data === undefined ? { requireExistingTab: true } : {}),
      });

      const invoke = async <T>(
        command: string,
        commandArgs: Record<string, unknown>,
      ): Promise<T> => {
        const handler = dependencies.commands.get(command);
        if (!handler) throw new Error(`Backend command is unavailable: ${command}`);
        return (await handler(commandArgs, context)) as T;
      };

      if (tabType === "claude-tmux") {
        const status = await invoke<{ running?: boolean } | null>("claude_tmux_status", {
          tabId,
          environmentId,
        });
        if (!status?.running) {
          await invoke("claude_tmux_start", {
            tabId,
            environmentId,
            initialPrompt: asOptionalString(args.initialPrompt),
            model: asOptionalString(args.model),
            effort: asOptionalString(args.reasoningEffort),
            ...(typeof args.fastMode === "boolean" ? { fastMode: args.fastMode } : {}),
          });
        }
        return { jobId, environmentId, tabId, tabType, status: "started" as const };
      }

      const trackEnvironmentActivity = tabType !== "plain";
      let created: { sessionId: string; created?: boolean; bootstrapped?: boolean };
      if (environment.environmentType === "local") {
        created = await invoke("create_local_terminal_session", {
          environmentId,
          terminalKey: tabId,
          cols: 80,
          rows: 24,
          trackEnvironmentActivity,
        });
        await invoke("start_local_terminal_session", { sessionId: created.sessionId });
      } else {
        created = await invoke("create_terminal_session", {
          containerId: environment.containerId,
          environmentId,
          terminalKey: tabId,
          cols: 80,
          rows: 24,
          trackEnvironmentActivity,
        });
        await invoke("start_terminal_session", { sessionId: created.sessionId });
      }
      if (data !== undefined) {
        const bootstrap = await invoke<{
          bootstrapped: boolean;
          duplicate?: boolean;
          matchesExisting?: boolean;
        }>("bootstrap_terminal_session", {
          sessionId: created.sessionId,
          data,
        });
        if (!bootstrap.bootstrapped) throw new Error("Terminal job could not be started");
        if (bootstrap.duplicate && bootstrap.matchesExisting !== true) {
          throw new Error("Terminal job session was already bootstrapped by another owner");
        }
      }
      // Publish the backend-owned PTY identity only after it is ready to attach.
      // The renderer is intentionally forbidden from manufacturing a replacement
      // for these tabs, so the durable pane snapshot must carry the exact session.
      await context.storage.ensureTerminalJobTab({
        environmentId,
        tabId,
        type: tabType,
        title,
        // The first publish already handled the requested selection. By the time
        // bootstrap finishes the user may have moved elsewhere or closed this
        // tab, and the identity update must not override either action.
        activate: false,
        terminalSessionId: created.sessionId,
        existingOnly: true,
      });
      return {
        jobId,
        environmentId,
        tabId,
        tabType,
        sessionId: created.sessionId,
        status: "started" as const,
      };
    },
    ASYNC_HANDLER,
  );

  register(
    createTerminalSessionCommand,
    async (
      { containerId, environmentId, terminalKey, cols, rows, user, trackEnvironmentActivity },
      { storage, runtime },
    ) => {
      const resolvedContainerId = containerId;
      const requestedEnvironmentId = asOptionalString(environmentId);
      runtime.environments.assertNotDeleting(requestedEnvironmentId);
      // A stop that is draining the container refuses new terminals into it.
      assertContainerNotDraining(resolvedContainerId);
      const requestedTerminalKey = asOptionalString(terminalKey);
      const shouldTrackActivity = asBoolean(trackEnvironmentActivity);
      const matchedEnvironment =
        shouldTrackActivity || requestedEnvironmentId
          ? findEnvironmentByContainerId(await storage.loadEnvironments(), resolvedContainerId)
          : undefined;
      runtime.environments.assertNotDeleting(requestedEnvironmentId ?? matchedEnvironment?.id);
      if (requestedEnvironmentId && matchedEnvironment?.id !== requestedEnvironmentId) {
        throw new Error("Terminal container is not associated with the requested environment");
      }
      const activityEnvironmentId = shouldTrackActivity ? matchedEnvironment?.id : undefined;
      if (shouldTrackActivity && !activityEnvironmentId) {
        throw new Error("Tracked terminal container is not associated with an environment");
      }
      if (requestedEnvironmentId) {
        assertEnvironmentDeletionNotRequested(matchedEnvironment, requestedEnvironmentId);
      } else if (matchedEnvironment) {
        assertEnvironmentDeletionNotRequested(matchedEnvironment, matchedEnvironment.id);
      }

      const stableKey = stableTerminalKey(
        "container",
        requestedEnvironmentId,
        requestedTerminalKey,
      );
      const config = {
        kind: "container" as const,
        containerId: resolvedContainerId,
        cols: asTerminalDimension(cols, 80),
        rows: asTerminalDimension(rows, 24),
        user: asOptionalString(user),
        environmentId: requestedEnvironmentId,
        activityEnvironmentId,
        trackEnvironmentActivity: shouldTrackActivity,
      };
      const existingId = runtime.terminals.existingStableSession(stableKey);
      if (existingId && runtime.terminals.containerConfigMatches(existingId, config)) {
        return {
          sessionId: existingId,
          created: false,
          bootstrapped: runtime.terminals.isBootstrapped(existingId),
        };
      }
      if (existingId) runtime.terminals.explicitlyCloseSession(existingId);

      const id = `${resolvedContainerId}:${randomUUID()}`;
      runtime.terminals.rememberStableSession(id, config, stableKey);
      runtime.terminals.history.configure({
        sessionId: id,
        dataDir: storage.getDataDir(),
        stableIdentity: stableKey ?? id,
        cols: config.cols,
        rows: config.rows,
        ...(requestedEnvironmentId ? { environmentId: requestedEnvironmentId } : {}),
        ...(requestedTerminalKey ? { tabId: requestedTerminalKey } : {}),
      });
      return { sessionId: id, created: true, bootstrapped: false };
    },
    ASYNC_HANDLER,
  );
  register(
    startTerminalSessionCommand,
    async ({ sessionId }, context) => {
      const { storage, runtime } = context;
      const id = sessionId;
      const storedConfig = runtime.terminals.sessionConfig(id);
      const config =
        storedConfig?.kind === "container"
          ? storedConfig
          : {
              kind: "container" as const,
              containerId: id.split(":")[0] ?? id,
              cols: 80,
              rows: 24,
            };
      const environmentId =
        config.environmentId ??
        config.activityEnvironmentId ??
        runtime.terminals.stableKeyEnvironmentId(id) ??
        undefined;
      runtime.environments.assertNotDeleting(environmentId);
      if (environmentId) {
        const environment = await storage.getEnvironment(environmentId);
        runtime.environments.assertNotDeleting(environmentId);
        assertEnvironmentDeletionNotRequested(environment, environmentId);
      }
      if (storedConfig && runtime.terminals.sessionConfig(id) !== storedConfig) {
        throw new Error("Container terminal session is no longer available");
      }
      // A `claude` or `codex` run in this shell should use the active account,
      // not whichever login the container was last handed. Best effort.
      await applyActiveAgentAccountsForContainerTerminal(context, config.containerId);
      if (storedConfig && runtime.terminals.sessionConfig(id) !== storedConfig) {
        throw new Error("Container terminal session is no longer available");
      }
      await runtime.terminals.history.resume(id);
      await assertContainerCheckoutAvailable(config.containerId, context);
      runtime.environments.fence.assertNotMoving(environmentId);
      spawnContainerTerminal(id, config, context, runtime.terminals.activityHooks(id, context));
    },
    ASYNC_HANDLER,
  );
  // `delivered` is additive: HTTP callers ignore the result, while the terminal
  // WebSocket gateway needs it to avoid acknowledging input that never reached a
  // shell. Dropping it silently would tell the user a keystroke landed.
  register(terminalWriteCommand, ({ sessionId: id, data: terminalData }, context) => {
    const { runtime } = context;
    const terminalProcess = runtime.terminals.process(id);
    if (!terminalProcess) return { delivered: false };
    terminalProcess.write(terminalData);
    runtime.terminals.recordInputActivity(id, terminalData, context);
    return { delivered: true };
  });
  register(terminalResizeCommand, ({ sessionId: id, cols, rows }, { runtime }) => {
    const terminalProcess = runtime.terminals.process(id);
    if (!terminalProcess) return { delivered: false };
    const resolvedCols = asTerminalDimension(cols, 80);
    const resolvedRows = asTerminalDimension(rows, 24);
    terminalProcess.resize(resolvedCols, resolvedRows);
    resizeTerminalHistoryBestEffort(runtime.terminals.history, id, resolvedCols, resolvedRows);
    return { delivered: true };
  });
  register(detachTerminalCommand, ({ sessionId }, { runtime }) => {
    runtime.terminals.explicitlyCloseSession(sessionId);
  });
  register(listTerminalSessionsCommand, (_args, { runtime }) => runtime.terminals.processIds());
  register(getTerminalSessionCommand, ({ sessionId: id }, { runtime }) => {
    const running = isTerminalSessionAttachable({ runtime }, id);
    if (isSetupTerminalSessionId(id)) {
      logSetupTerminal("setup.renderer-checked-session", {
        sessionId: id,
        running,
        terminalRunning: runtime.terminals.hasProcess(id),
        bufferChars: runtime.terminals.outputLength(id),
      });
    }
    return { id, running, bootstrapped: runtime.terminals.isBootstrapped(id) };
  });
  register(bootstrapTerminalSessionCommand, ({ sessionId: id, data: terminalData }, context) => {
    const { runtime } = context;
    const bootstrapDataHash = createHash("sha256").update(terminalData).digest("hex");
    return runtime.terminals.bootstrapSession(
      id,
      bootstrapDataHash,
      () => {
        const config = runtime.terminals.sessionConfig(id)!;
        // A container's OpenCode tab runs its image's 2.x TUI (opencode2/container-terminal-launch.ts).
        if (config.kind === "container") {
          return containerOpenCodeTerminalCommand(terminalData, config.user);
        }
        // Only the canonical OpenCode launch is rewritten. Plain commands and
        // the shared interactive shell keep the user's defaults.
        const openCodeLaunch =
          config.kind === "local" ? parseTerminalOpenCodeLaunchCommand(terminalData) : null;
        if (config.kind !== "local" || !openCodeLaunch) return terminalData;
        // The managed OpenCode TUI with the host server's storage (opencode2/terminal-launch.ts).
        return resolveOpenCode2TerminalCommand(
          {
            storage: context.storage,
            resolveCliPath: () => resolveManagedBinary(context, "opencode2"),
            resolveBunPath: () => resolveBunBinary(context),
            writeConfig: writeOpenCode2HostConfig,
          },
          config.environmentId,
          openCodeLaunch,
        ).then((line) =>
          line === undefined ? terminalData : `${line}${openCodeLaunch.lineEnding}`,
        );
      },
      context,
    );
  });
  register(getTerminalOutputBufferCommand, ({ sessionId: id }, { runtime }) => {
    const buffer = runtime.terminals.readOutput(id);
    if (isSetupTerminalSessionId(id)) {
      logSetupTerminal("setup.renderer-requested-buffer", {
        sessionId: id,
        bufferChars: buffer.length,
        running: runtime.terminals.hasProcess(id),
      });
    }
    return buffer;
  });
  register(
    getTerminalOutputSnapshotCommand,
    ({ sessionId: id, sinceRevision, sinceGeneration }, { runtime }) => {
      const revision = runtime.terminals.outputRevision(id) ?? 0;
      const generation = runtime.terminals.outputGeneration(id) ?? 0;
      if (sinceRevision !== undefined || sinceGeneration !== undefined) {
        const requestedRevision = asNumber(sinceRevision, "sinceRevision");
        const requestedGeneration = asNumber(sinceGeneration, "sinceGeneration");
        const deltas = runtime.terminals.retainedOutputDeltas(id);
        const oldestRevision = deltas[0]?.revision ?? revision + 1;
        if (
          Number.isSafeInteger(requestedRevision) &&
          requestedRevision >= 0 &&
          Number.isSafeInteger(requestedGeneration) &&
          requestedGeneration === generation &&
          requestedRevision <= revision &&
          requestedRevision >= oldestRevision - 1
        ) {
          const retainedDeltas = deltas
            .filter((entry) => entry.revision > requestedRevision)
            .map((entry) => ({ revision: entry.revision, text: entry.text }));
          return {
            mode: "delta" as const,
            output: retainedDeltas.map((entry) => entry.text).join(""),
            // The WebSocket gateway preserves revision boundaries when replaying
            // raw binary output. Existing HTTP clients ignore this additive field.
            deltas: retainedDeltas,
            revision,
            generation,
            truncated: false,
          };
        }
        return {
          mode: "full" as const,
          reason:
            requestedGeneration === generation
              ? ("expired" as const)
              : ("generation-changed" as const),
          output: runtime.terminals.readOutput(id),
          revision,
          generation,
          truncated: runtime.terminals.isOutputTruncated(id),
        };
      }
      return {
        output: runtime.terminals.readOutput(id),
        revision,
        generation,
        truncated: runtime.terminals.isOutputTruncated(id),
      };
    },
  );

  register(
    getTerminalStateSnapshotCommand,
    async ({ sessionId: id }, { storage, runtime }) => {
      let snapshot = await runtime.terminals.history.stateSnapshot(id);
      if (!snapshot && isSetupTerminalSessionId(id)) {
        const environmentId = id.slice(0, -":setup".length);
        if (await storage.getEnvironment(environmentId)) {
          runtime.terminals.history.configure({
            sessionId: id,
            dataDir: storage.getDataDir(),
            stableIdentity: `setup\0${environmentId}`,
            cols: 80,
            rows: 24,
            environmentId,
            tabId: "setup",
            generation: runtime.terminals.outputGeneration(id) ?? 1,
          });
          snapshot = await runtime.terminals.history.stateSnapshot(id);
        }
      }
      return snapshot;
    },
    ASYNC_HANDLER,
  );

  register(getTerminalHistoryPageCommand, ({ sessionId, cursor }, { runtime }) =>
    runtime.terminals.history.page(sessionId, cursor),
  );

  // Browser gateways consume this locally to release their buffered live
  // frames. Native/Electron callers still need the command to exist so the
  // renderer can use one application barrier on every transport.
  register(terminalSnapshotAppliedCommand, () => ({ acknowledged: true as const }));
  register(terminalSnapshotFailedCommand, () => ({ acknowledged: true as const }));

  register(
    createLocalTerminalSessionCommand,
    async (
      { environmentId: resolvedEnvironmentId, terminalKey, cols, rows, trackEnvironmentActivity },
      { storage, runtime },
    ) => {
      runtime.environments.assertNotDeleting(resolvedEnvironmentId);
      // A shell opened in the folder being moved would be left behind in it.
      runtime.environments.fence.assertNotMoving(resolvedEnvironmentId);
      const environment = await storage.getEnvironment(resolvedEnvironmentId);
      runtime.environments.assertNotDeleting(resolvedEnvironmentId);
      assertEnvironmentDeletionNotRequested(environment, resolvedEnvironmentId);
      runtime.environments.fence.assertNotMoving(resolvedEnvironmentId);
      const stableKey = stableTerminalKey(
        "local",
        resolvedEnvironmentId,
        asOptionalString(terminalKey),
      );
      const config = {
        kind: "local" as const,
        environmentId: resolvedEnvironmentId,
        cols: asTerminalDimension(cols, 80),
        rows: asTerminalDimension(rows, 24),
        trackEnvironmentActivity: asBoolean(trackEnvironmentActivity),
      };
      const existingId = runtime.terminals.existingStableSession(stableKey);
      if (existingId && runtime.terminals.localConfigMatches(existingId, config)) {
        return {
          sessionId: existingId,
          created: false,
          bootstrapped: runtime.terminals.isBootstrapped(existingId),
        };
      }
      if (existingId) runtime.terminals.explicitlyCloseSession(existingId);

      const id = `${resolvedEnvironmentId}:${randomUUID()}`;
      runtime.terminals.rememberStableSession(id, config, stableKey);
      runtime.terminals.history.configure({
        sessionId: id,
        dataDir: storage.getDataDir(),
        stableIdentity: stableKey ?? id,
        cols: config.cols,
        rows: config.rows,
        environmentId: resolvedEnvironmentId,
        ...(asOptionalString(terminalKey) ? { tabId: asOptionalString(terminalKey) } : {}),
      });
      return { sessionId: id, created: true, bootstrapped: false };
    },
    ASYNC_HANDLER,
  );
  register(
    startLocalTerminalSessionCommand,
    async ({ sessionId: id }, context) => {
      const { storage, runtime } = context;
      const storedConfig = runtime.terminals.sessionConfig(id);
      const config =
        storedConfig?.kind === "local"
          ? storedConfig
          : {
              kind: "local" as const,
              environmentId: id.split(":")[0] ?? id,
              cols: 80,
              rows: 24,
            };
      const environmentId = config.environmentId;
      runtime.environments.assertNotDeleting(environmentId);
      const env = await storage.getEnvironment(environmentId);
      runtime.environments.assertNotDeleting(environmentId);
      assertEnvironmentDeletionNotRequested(env, environmentId);
      if (!env?.worktreePath) throw new Error("Local environment worktree is not available");
      if (!(await pathExists(env.worktreePath)))
        throw new Error(`Local environment worktree does not exist: ${env.worktreePath}`);
      runtime.environments.assertNotDeleting(environmentId);
      const currentEnvironment = await storage.getEnvironment(environmentId);
      runtime.environments.assertNotDeleting(environmentId);
      context.runtime.environments.fence.assertNotMoving(environmentId);
      assertEnvironmentDeletionNotRequested(currentEnvironment, environmentId);
      if (
        !currentEnvironment?.worktreePath ||
        currentEnvironment.worktreePath !== env.worktreePath
      ) {
        throw new Error("Local environment worktree is no longer available");
      }
      if (storedConfig && runtime.terminals.sessionConfig(id) !== storedConfig) {
        throw new Error("Local terminal session is no longer available");
      }
      // A terminal keeps the account that was active when it started; a switch
      // applies to terminals opened after it.
      const accountEnvironment = await activeAgentAccountShellEnvironment(context);
      const launchEnvironment = { ...envWithManagedBinaries(context), ...accountEnvironment };
      if (accountEnvironment.CLAUDE_CONFIG_DIR || accountEnvironment.CODEX_HOME) {
        stripInheritedAgentCredentials(launchEnvironment);
      }
      await runtime.terminals.history.resume(id);
      const launchTarget = await storage.getEnvironment(environmentId);
      runtime.environments.assertNotDeleting(environmentId);
      context.runtime.environments.fence.assertNotMoving(environmentId);
      assertEnvironmentDeletionNotRequested(launchTarget, environmentId);
      if (
        launchTarget?.worktreePath !== currentEnvironment.worktreePath ||
        runtime.terminals.sessionConfig(id) !== storedConfig
      ) {
        throw new Error("Local terminal session or worktree is no longer available");
      }
      const alreadyRunning = runtime.terminals.hasProcess(id);
      const terminalProcess = spawnTerminalProcess(
        id,
        resolveLocalShellPath(),
        ["-l"],
        {
          cwd: currentEnvironment.worktreePath,
          cols: config.cols,
          rows: config.rows,
          env: launchEnvironment,
        },
        context,
        runtime.terminals.activityHooks(id, context),
      );
      if (!alreadyRunning && runtime.terminals.process(id) === terminalProcess) {
        for (const home of [accountEnvironment.CLAUDE_CONFIG_DIR, accountEnvironment.CODEX_HOME]) {
          if (home) runtime.terminals.recordAccountHome(`${id}:${home}`, home);
        }
      }
    },
    ASYNC_HANDLER,
  );
  register(localTerminalWriteCommand, ({ sessionId: id, data: terminalData }, context) => {
    const { runtime } = context;
    const terminalProcess = runtime.terminals.process(id);
    if (!terminalProcess) return { delivered: false };
    terminalProcess.write(terminalData);
    runtime.terminals.recordInputActivity(id, terminalData, context);
    return { delivered: true };
  });
  register(localTerminalResizeCommand, ({ sessionId: id, cols, rows }, { runtime }) => {
    const terminalProcess = runtime.terminals.process(id);
    if (!terminalProcess) return { delivered: false };
    const resolvedCols = asTerminalDimension(cols, 80);
    const resolvedRows = asTerminalDimension(rows, 24);
    terminalProcess.resize(resolvedCols, resolvedRows);
    resizeTerminalHistoryBestEffort(runtime.terminals.history, id, resolvedCols, resolvedRows);
    return { delivered: true };
  });
  register(closeLocalTerminalSessionCommand, ({ sessionId }, { runtime }) => {
    runtime.terminals.explicitlyCloseSession(sessionId);
  });

  // The git status, diff-stat and worktree-probe commands are registered with
  // their `git` definitions (plan item 7006).
  register(
    getLocalGitStatusCommand,
    async ({ worktreePath, targetBranch, includeUncommitted, knownDigest, refresh }, context) => {
      // The sidebar badge, every client's Files panel and the background scan
      // look at the same worktree; they share one read owner and one scan.
      const read = await context.runtime.diffStats.service.readFileList({
        lookup: { worktreePath: asString(worktreePath, "worktreePath") },
        comparisonRef: asString(targetBranch, "targetBranch"),
        includeUncommitted: includeUncommitted !== false,
        refresh: refreshRequested(refresh),
      });
      return snapshotResponse(
        "file-list-read",
        read.changes as GitFileChange[],
        read.digest,
        knownDigest,
        read.view,
      );
    },
    ASYNC_HANDLER,
  );
  /**
   * Authoritative diff-stat snapshot.
   *
   * A client that mounts, remounts, or reconnects reads this rather than trying
   * to reconstruct state from the events it happened to be listening for. It
   * also arms tracking, so the first client to ask starts the work even if no
   * lifecycle command has run since the backend started.
   */
  register(
    getEnvironmentDiffStatsCommand,
    async (args, context) => {
      await context.runtime.diffStats.sync(context);
      // Legacy `{ entries }` shape (additively stamped) without known-revision
      // arguments; the compact conditional outcome from `view-sync.ts` with them.
      const request = parseViewSnapshotRequest(args);
      if (request.kind === "absent") {
        return context.runtime.diffStats.service.revisionedSnapshot() satisfies EnvironmentDiffStatsSnapshot;
      }
      return resolveViewSnapshotOutcome(
        request,
        context.runtime.diffStats.service.currentRevision(),
        () => ({
          entries: context.runtime.diffStats.service.snapshot(),
        }),
      ) satisfies EnvironmentDiffStatsSnapshotOutcome;
    },
    ASYNC_HANDLER,
  );
  /**
   * File-list and tree revisions of every tracked environment
   * (`@orkestrator/protocol/worktree-snapshots`). Like the diff-stat snapshot,
   * it arms tracking and answers conditional reads compactly.
   */
  register(
    getWorktreeSnapshotRevisionsCommand,
    async (args, context) => {
      await context.runtime.diffStats.sync(context);
      const request = parseViewSnapshotRequest(args);
      if (request.kind === "absent") {
        return context.runtime.diffStats.service.revisionedWorktreeSnapshot() satisfies WorktreeSnapshotRevisionsSnapshot;
      }
      return resolveViewSnapshotOutcome(
        request,
        context.runtime.diffStats.service.currentWorktreeRevision(),
        () => ({
          entries: context.runtime.diffStats.service.worktreeSnapshotEntries(),
        }),
      ) satisfies WorktreeSnapshotRevisionsOutcome;
    },
    ASYNC_HANDLER,
  );

  register(
    getLocalFileTreeCommand,
    async ({ worktreePath, knownDigest, refresh }, context) => {
      const read = await context.runtime.diffStats.service.readTree({
        lookup: { worktreePath },
        refresh: refreshRequested(refresh),
      });
      return snapshotResponse(
        "file-tree-read",
        // The owner's tree is the walker's `FileTreeNode[]` (`commands-files.ts`).
        read.tree as readonly FileTreeNode[],
        read.digest,
        knownDigest,
        read.view,
      );
    },
    ASYNC_HANDLER,
  );
  // One truncated tree directory, read when the files panel expands it. Not
  // cached: each expansion or refresh reads the directory as it is now. With a
  // `knownDigest` an unchanged directory answers with no contents.
  register(
    getLocalFileSubtreeCommand,
    async ({ worktreePath, directory, knownDigest }) =>
      conditionalSnapshot(await buildFileSubtree(worktreePath, directory), knownDigest),
    ASYNC_HANDLER,
  );
  register(
    readLocalFileCommand,
    async ({ worktreePath, filePath: relativePath }, context) => {
      const { environment } = await requireRegisteredLocalRoot(context, worktreePath);
      return readTextFile(environment.worktreePath, relativePath);
    },
    ASYNC_HANDLER,
  );
  // Only the diff viewer of v2.21.0 to v2.23.0 asks this and
  // `read_file_at_branch` (to-do 7570 task 2).
  register(readLocalFileAtBranchCommand, ({ worktreePath, filePath, branch }, context) => {
    compatibilityPathUsage.record("retired-command.read-file-at-branch");
    return readLocalFileAtBranch(
      worktreePath,
      filePath,
      branch,
      context.runtime.diffStats.gitFetchScheduler,
    );
  });
  register(
    readFileBase64Command,
    async ({ filePath }, context) => readFileBase64(filePath, await readableHostFileRoots(context)),
    ASYNC_HANDLER,
  );
  // Strict (`assertOnlyKeys`) before plan item 7002; tolerant now (§11.4).
  register(
    readEnvironmentFileBase64Command,
    async (args, context) => {
      const environment = await requireLocalMutationEnvironment(
        context.storage,
        args.environmentId,
      );
      const relative = validateRelativeFilePath(args.filePath);
      return readFileBase64(path.join(environment.worktreePath!, relative), [
        environment.worktreePath!,
      ]);
    },
    ASYNC_HANDLER,
  );
  // `expected` (optional) is the editor's precondition: the write happens
  // only while the file still has the content it loaded. Older clients omit it.
  register(
    writeLocalFileCommand,
    async ({ worktreePath: root, filePath: relativePath, base64Data: data, expected }, context) => {
      const precondition = parseFileWritePrecondition(expected);
      const release = context.runtime.environments.fence.beginWorktreeMutation(root);
      try {
        // Coordinators stage pasted images through `write_coordinator_attachment`;
        // nothing may write a directory that is not an environment's worktree.
        const { environment, canonical } = await requireRegisteredLocalRoot(context, root);
        return await withLocalFileMutation(context, environment.id, async (current) => {
          const currentRoot = current.worktreePath!;
          if (canonicalWorktreePath(currentRoot) !== canonical)
            throw new Error("The worktree moved; refresh before saving");
          return precondition
            ? serializeFileWrite(`local:${canonical}:${relativePath}`, async () => {
                await assertLocalFileUnchanged(currentRoot, relativePath, precondition);
                return writeFileBase64(currentRoot, relativePath, data);
              })
            : writeFileBase64(currentRoot, relativePath, data);
        });
      } finally {
        release();
      }
    },
    ASYNC_HANDLER,
  );
  register(
    revertLocalFileCommand,
    async ({ environmentId: id, filePath, targetBranch }, context) => {
      return withLocalFileMutation(context, id, async (environment) => {
        const result = await revertLocalFile(
          environment.worktreePath!,
          filePath,
          targetBranch,
          context.runtime.diffStats.gitFetchScheduler,
        );
        context.runtime.diffStats.service.invalidateChanges({
          worktreePath: environment.worktreePath!,
        });
        context.runtime.diffStats.service.refresh(id);
        return result;
      });
    },
    ASYNC_HANDLER,
  );
  register(
    deleteLocalFileCommand,
    async ({ environmentId: id, filePath }, context) => {
      return withLocalFileMutation(context, id, async (environment) => {
        try {
          return await deleteLocalFile(environment.worktreePath!, filePath);
        } finally {
          // A failed recursive removal can still have changed files or the index.
          context.runtime.diffStats.service.invalidateChanges({
            worktreePath: environment.worktreePath!,
          });
          context.runtime.diffStats.service.refresh(id);
        }
      });
    },
    ASYNC_HANDLER,
  );
  register(
    moveLocalFileCommand,
    async ({ environmentId: id, sourcePath, destinationDirectory }, context) => {
      return withLocalFileMutation(context, id, async (environment) => {
        const result = await moveLocalFile(
          environment.worktreePath!,
          sourcePath,
          destinationDirectory,
        );
        context.runtime.diffStats.service.invalidateChanges({
          worktreePath: environment.worktreePath!,
        });
        context.runtime.diffStats.service.refresh(id);
        return result;
      });
    },
    ASYNC_HANDLER,
  );
  register(
    renameLocalFileCommand,
    async ({ environmentId: id, filePath, newName }, context) => {
      return withLocalFileMutation(context, id, async (environment) => {
        const result = await renameLocalFile(environment.worktreePath!, filePath, newName);
        context.runtime.diffStats.service.invalidateChanges({
          worktreePath: environment.worktreePath!,
        });
        context.runtime.diffStats.service.refresh(id);
        return result;
      });
    },
    ASYNC_HANDLER,
  );
  register(
    createLocalFolderCommand,
    async ({ environmentId: id, parentDirectory, folderName }, context) => {
      return withLocalFileMutation(context, id, async (environment) => {
        const result = await createLocalFolder(
          environment.worktreePath!,
          parentDirectory,
          folderName,
        );
        context.runtime.diffStats.service.invalidateChanges({
          worktreePath: environment.worktreePath!,
        });
        context.runtime.diffStats.service.refresh(id);
        return result;
      });
    },
    ASYNC_HANDLER,
  );

  register(
    getGitStatusCommand,
    async ({ containerId, targetBranch, includeUncommitted, knownDigest, refresh }, context) => {
      const ref = validateGitRefName(asString(targetBranch, "targetBranch"), "target branch");
      const id = asString(containerId, "containerId");
      const explicit = refreshRequested(refresh);
      // A manual refresh also asks for the remote: the fetch policy makes the
      // ref due (unless a fetch started or ended in the last 15 s) and the
      // post-click scan below starts it in the background. The read itself
      // answers from local refs and never waits for the network; a fetch
      // that moves the base announces a new file-list revision.
      if (explicit)
        context.runtime.diffStats.containerGitFetchPolicy.invalidate(
          { containerId: id, ref },
          "explicit",
        );
      // A missing baseline surfaces as "Target ref is not present in the
      // container" from the scanner, distinct from a corrupt response.
      const read = await context.runtime.diffStats.service.readFileList({
        lookup: { containerId: id },
        comparisonRef: ref,
        includeUncommitted: includeUncommitted !== false,
        refresh: explicit,
      });
      return snapshotResponse(
        "file-list-read",
        read.changes as GitFileChange[],
        read.digest,
        knownDigest,
        read.view,
      );
    },
    ASYNC_HANDLER,
  );
  /**
   * Authoritative uncommitted-path list for one environment, for callers that
   * need the fact itself rather than a diff to render.
   *
   * The build pipeline reads this before and after writable validation stages.
   * Returning HEAD with the porcelain paths lets it reject both ordinary edits
   * and an agent-created commit before accepting a review or verification
   * result.
   *
   * `fingerprint: true` additionally hashes the whole `git diff HEAD` and every
   * untracked file, which detects edits *inside* paths that were already dirty.
   * It is opt-in because it is expensive and because the build pipeline's guard
   * compares path sets rather than bytes: only a caller that must pin reviewers
   * to identical source needs it.
   *
   * Scope is what Git reports and no more: tracked paths, plus untracked paths
   * Git does not ignore. Ignored files, anything under `.git/`, and paths
   * outside the worktree are invisible here, so no caller may describe this as
   * proof that the workspace was untouched.
   */
  register(
    getEnvironmentUncommittedPathsCommand,
    async (args, context) => {
      const { environmentId, fingerprint } = args;
      const environment = await context.storage.getEnvironment(
        asString(environmentId, "environmentId"),
      );
      if (!environment) throw new Error("Environment not found");
      const wantFingerprint =
        fingerprint === undefined ? false : asRequiredBoolean(fingerprint, "fingerprint");
      const runner = createEnvironmentCommandRunner(
        environment,
        context.runtime.environments.fence,
        context.storage,
        context.runtime.gitHubCli,
      );
      // The container image ships Node; a local worktree runs on the user's own
      // machine, where the backend's inherited PATH is whatever the OS handed
      // Electron and need not contain any Node at all. Use the same managed Bun
      // the rest of the local command surface relies on.
      const local = environment.environmentType === "local";
      const timeoutMs = wantFingerprint
        ? REVIEW_WORKTREE_FINGERPRINT_TIMEOUT_MS
        : REVIEW_WORKTREE_PROBE_TIMEOUT_MS;
      const captured = parseReviewWorktreeFingerprint(
        await worktreeProbes.run(`${environment.id}\0${wantFingerprint}`, () =>
          runner(
            local ? resolveBunBinary(context) : "node",
            reviewWorktreeProbeArgs(wantFingerprint, timeoutMs),
            timeoutMs,
            local ? envWithManagedBinaries(context) : undefined,
          ),
        ),
      );
      return {
        head: captured.head,
        paths: parseGitPorcelainPaths(captured.status),
        ...(captured.fingerprint === undefined ? {} : { fingerprint: captured.fingerprint }),
      };
    },
    ASYNC_HANDLER,
  );
  /**
   * Whether commit `ancestor` is `descendant` or one of its ancestors in an
   * environment's repository. The build pipeline asks before Verify whether
   * the validated commit survived Address, and states the answer.
   *
   * `isAncestor` is null when Git cannot say (an unknown commit, unrelated
   * histories). The answer comes from `git merge-base` rather than
   * `--is-ancestor`, whose nonzero exit means both "no" and "failed".
   */
  register(
    getEnvironmentCommitAncestryCommand,
    async (args, context) => {
      const commit = (value: unknown, name: string) => {
        const id = asString(value, name).toLowerCase();
        if (!/^[0-9a-f]{40,64}$/.test(id)) throw new Error(`${name} must be a full commit id`);
        return id;
      };
      const ancestor = commit(args.ancestor, "ancestor");
      const descendant = commit(args.descendant, "descendant");
      const environment = await context.storage.getEnvironment(
        asString(args.environmentId, "environmentId"),
      );
      if (!environment) throw new Error("Environment not found");
      const runner = createEnvironmentCommandRunner(
        environment,
        context.runtime.environments.fence,
        context.storage,
        context.runtime.gitHubCli,
      );
      let mergeBase: string;
      try {
        mergeBase = (await runner("git", ["merge-base", ancestor, descendant], 30_000))
          .trim()
          .toLowerCase();
      } catch {
        return { isAncestor: null };
      }
      return { isAncestor: /^[0-9a-f]{40,64}$/.test(mergeBase) ? mergeBase === ancestor : null };
    },
    ASYNC_HANDLER,
  );
  register(
    getFileTreeCommand,
    async ({ containerId, knownDigest, refresh }, context) => {
      const read = await context.runtime.diffStats.service.readTree({
        lookup: { containerId },
        refresh: refreshRequested(refresh),
      });
      return snapshotResponse(
        "file-tree-read",
        // The owner's tree is the walker's `FileTreeNode[]` (`commands-files.ts`).
        read.tree as readonly FileTreeNode[],
        read.digest,
        knownDigest,
        read.view,
      );
    },
    ASYNC_HANDLER,
  );
  register(
    getFileSubtreeCommand,
    async ({ containerId, directory, knownDigest }) => {
      const target = validateFileTreeDirectory(directory);
      return conditionalSnapshot(
        parseContainerFileSubtree(
          await dockerExec(
            containerId,
            `node -e ${quoteShell(CONTAINER_FILE_TREE_LISTER)} -- /workspace ${MAX_FILE_TREE_NODES} ${quoteShell(target)}`,
          ),
          target,
        ),
        knownDigest,
      );
    },
    ASYNC_HANDLER,
  );
  register(
    readContainerFileCommand,
    async ({ containerId, filePath }) => {
      const target = validateRelativeFilePath(filePath);
      const encoded = await dockerExec(
        containerId,
        `node -e ${quoteShell(CONTAINER_SAFE_BASE64_READER)} -- /workspace ${quoteShell(workspaceFilePath(target))} ${MAX_TEXT_FILE_BYTES} editor ${quoteShell(MAX_TEXT_FILE_SIZE_LABEL)}`,
      );
      const content = decodeEditorTextFile(Buffer.from(encoded.trim(), "base64"));
      return { path: target, content, language: inferLanguage(target) };
    },
    ASYNC_HANDLER,
  );
  register(
    readFileAtBranchCommand,
    async ({ containerId, filePath, branch }) => {
      compatibilityPathUsage.record("retired-command.read-file-at-branch");
      const target = validateRelativeFilePath(filePath);
      const object = `${branch}:${target}`;
      // One `git cat-file --batch` answers the size and the body; the output is
      // cut after the largest acceptable answer, so an oversized blob is refused
      // from its header without crossing the exec channel in full.
      const encoded = await dockerExec(
        containerId,
        containerGitBlobReadCommand(object, MAX_TEXT_FILE_BYTES),
      );
      const read = decodeGitBatchOutput(Buffer.from(encoded, "base64"), MAX_TEXT_FILE_BYTES);
      if (read?.kind === "too-large") assertEditorTextFileSize(read.size);
      if (read?.kind !== "blob") return null;
      const content = decodeEditorTextFile(read.bytes);
      return { path: target, content, language: inferLanguage(target) };
    },
    ASYNC_HANDLER,
  );
  register(
    readContainerFileBase64Command,
    async ({ containerId, filePath }) => {
      const fullPath = workspaceFilePath(filePath);
      return (
        await dockerExec(
          containerId,
          `node -e ${quoteShell(CONTAINER_SAFE_BASE64_READER)} -- /workspace ${quoteShell(fullPath)} ${MAX_BINARY_FILE_BYTES}`,
        )
      ).trim();
    },
    ASYNC_HANDLER,
  );
  register(
    writeContainerFileCommand,
    async ({ containerId: id, filePath, base64Data: data, expected }) => {
      const target = validateRelativeFilePath(filePath);
      const precondition = parseFileWritePrecondition(expected);
      const fullPath = workspaceFilePath(target);
      assertBase64PayloadWithinLimit(data);
      if (isAnnotationEvidencePath(target)) {
        // App-owned evidence: no symbolic link anywhere on the path, exclusive
        // temp file, atomic rename. A workspace cannot redirect this write.
        await runContainerEvidenceScript(
          runCommand,
          id,
          CONTAINER_EVIDENCE_WRITER,
          ["/workspace", target, String(MAX_BASE64_PAYLOAD_BYTES)],
          data,
        );
        return fullPath;
      }
      const write = async () => {
        // A refused precondition exits before reading stdin, which is expected.
        await runContainerWrite(
          id,
          ["bash", "-lc", containerFileWriteScript(fullPath, precondition)],
          data,
          {
            errorForExit: (code) =>
              code === CONTAINER_WRITE_CONFLICT_EXIT ? fileWriteConflictError() : undefined,
          },
        );
        return fullPath;
      };
      return precondition ? serializeFileWrite(`container:${id}:${fullPath}`, write) : write();
    },
    ASYNC_HANDLER,
  );
  // Containment and existence of agent-reported paths in a container
  // workspace (web annotation file checks). Runs `stat` only, inside the
  // container, with the same bounds as the local check; never reads contents.
  register(
    checkContainerWorkspacePathsCommand,
    async ({ containerId, paths }) => {
      const id = asNonBlankString(containerId, "containerId");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) {
        throw new Error("containerId must be a Docker container name or ID");
      }
      if (
        !Array.isArray(paths) ||
        paths.length > MAX_WORKSPACE_PATH_CHECKS ||
        !paths.every((entry) => typeof entry === "string" && isSafeRelativePath(entry))
      ) {
        throw new Error("paths must be at most 200 workspace-relative paths");
      }
      // Paths travel as JSON on stdin, never on the exec command line.
      return runContainerPathCheck(runCommand, id, paths as string[]);
    },
    ASYNC_HANDLER,
  );
  register(
    deleteContainerAnnotationEvidenceCommand,
    async ({ containerId: id, filePath, digest: hash }) => {
      const target = validateRelativeFilePath(filePath);
      if (!isAnnotationEvidencePath(target)) {
        throw new Error("Path is not an app-generated evidence path");
      }
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("digest is invalid");
      const output = await runContainerEvidenceScript(
        runCommand,
        id,
        CONTAINER_EVIDENCE_REMOVER,
        ["/workspace", target, hash, String(WEB_ANNOTATION_LIMITS.imageBytes)],
        "",
      );
      const outcome = output.trim();
      if (outcome !== "removed" && outcome !== "missing" && outcome !== "mismatch") {
        throw new Error("Unexpected evidence removal result");
      }
      return outcome;
    },
    ASYNC_HANDLER,
  );
  register(
    revertContainerFileCommand,
    async ({ environmentId, filePath, targetBranch }, context) => {
      const environmentIdString = environmentId;
      const environment = await requireContainerMutationEnvironment(
        context.storage,
        environmentIdString,
      );
      const id = environment.containerId!;
      const target = validateWorkspaceMutationPath(filePath);
      const branch = validateGitRefName(targetBranch, "target branch");
      await revertContainerFile(id, target, branch, {
        exec: (containerId, script) => dockerExec(containerId, script),
        fetches: context.runtime.diffStats.containerGitFetchPolicy,
        admission: gitDockerScanPool,
      });
      context.runtime.diffStats.service.invalidateChanges({ containerId: id });
      context.runtime.diffStats.service.refresh(environmentIdString);
      return target;
    },
    ASYNC_HANDLER,
  );
  register(
    deleteContainerFileCommand,
    async ({ environmentId, filePath }, context) => {
      const environmentIdString = environmentId;
      const environment = await requireContainerMutationEnvironment(
        context.storage,
        environmentIdString,
      );
      const id = environment.containerId!;
      const target = validateWorkspaceMutationPath(filePath);
      try {
        await dockerExec(id, containerDeleteFileCommand(target));
        return target;
      } finally {
        context.runtime.diffStats.service.invalidateChanges({ containerId: id });
        context.runtime.diffStats.service.refresh(environmentIdString);
      }
    },
    ASYNC_HANDLER,
  );
  register(
    moveContainerFileCommand,
    async ({ environmentId, sourcePath, destinationDirectory }, context) => {
      const environmentIdString = environmentId;
      const environment = await requireContainerMutationEnvironment(
        context.storage,
        environmentIdString,
      );
      const id = environment.containerId!;
      const move = resolveWorkspaceFileMove(sourcePath, destinationDirectory);
      await dockerExec(id, containerMoveFileCommand(move.source, move.directory, move.destination));
      context.runtime.diffStats.service.invalidateChanges({ containerId: id });
      context.runtime.diffStats.service.refresh(environmentIdString);
      return move.destination;
    },
    ASYNC_HANDLER,
  );
  register(
    renameContainerFileCommand,
    async ({ environmentId, filePath, newName }, context) => {
      const environmentIdString = environmentId;
      const environment = await requireContainerMutationEnvironment(
        context.storage,
        environmentIdString,
      );
      const id = environment.containerId!;
      const rename = resolveWorkspaceFileRename(filePath, newName);
      await dockerExec(
        id,
        containerMoveFileCommand(rename.source, rename.directory, rename.destination),
      );
      context.runtime.diffStats.service.invalidateChanges({ containerId: id });
      context.runtime.diffStats.service.refresh(environmentIdString);
      return rename.destination;
    },
    ASYNC_HANDLER,
  );
  register(
    createContainerFolderCommand,
    async ({ environmentId, parentDirectory, folderName }, context) => {
      const environmentIdString = environmentId;
      const environment = await requireContainerMutationEnvironment(
        context.storage,
        environmentIdString,
      );
      const id = environment.containerId!;
      const created = resolveWorkspaceFolderCreate(parentDirectory, folderName);
      await dockerExec(id, containerCreateFolderCommand(created.directory, created.folderPath));
      context.runtime.diffStats.service.invalidateChanges({ containerId: id });
      context.runtime.diffStats.service.refresh(environmentIdString);
      return created.folderPath;
    },
    ASYNC_HANDLER,
  );

  register(
    copyExternalFileCommand,
    async (
      {
        environmentId: environmentIdString,
        destinationDirectory: directory,
        fileName: name,
        base64Data,
      },
      context,
    ) => {
      const data = assertBase64PayloadWithinLimit(base64Data);
      const copy = resolveWorkspaceExternalFileCopy(directory, name);
      const environment = await context.storage.getEnvironment(environmentIdString);
      if (!environment) throw new Error(`Environment not found: ${environmentIdString}`);

      if (environment.environmentType === "local") {
        await withLocalFileMutation(context, environmentIdString, async (local) => {
          await copyExternalFileToLocalWorkspace(local.worktreePath!, directory, name, data);
          context.runtime.diffStats.service.invalidateChanges({
            worktreePath: local.worktreePath!,
          });
        });
      } else {
        const container = await requireContainerMutationEnvironment(
          context.storage,
          environmentIdString,
        );
        try {
          await dependencies.runContainerFileCopyCommand(
            "docker",
            [
              "exec",
              "-i",
              container.containerId!,
              "node",
              "-e",
              CONTAINER_PINNED_ATTACHMENT_WRITE,
              "/workspace",
              copy.directory,
              copy.fileName,
              String(base64DecodedByteLength(data)),
              "",
              "exclusive",
              String(0o644),
              "existing",
            ],
            { stdin: data, timeoutMs: dependencies.containerFileCopyTimeoutMs },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const exitCode = error instanceof CommandFailedError ? error.exitCode : undefined;
          if ((exitCode === 76 || exitCode === undefined) && message.includes("EEXIST")) {
            throw new Error(`A file already exists at ${copy.destination}`);
          }
          if ((exitCode === 77 || exitCode === undefined) && message.includes("ENOENT_ANCESTOR")) {
            throw new Error(
              copy.directory === "."
                ? "Workspace root is not available"
                : `Destination directory no longer exists: ${copy.directory}`,
            );
          }
          throw new Error("The file could not be copied into the container workspace");
        }
        context.runtime.diffStats.service.invalidateChanges({
          containerId: container.containerId!,
        });
      }
      context.runtime.diffStats.service.refresh(environmentIdString);
      return copy.destination;
    },
    ASYNC_HANDLER,
  );

  const writeInitialPromptAttachments = async (
    {
      environmentId: environmentIdString,
      attachments,
    }: { environmentId: string; attachments?: unknown },
    context: CommandContext,
  ) => {
    if (!Array.isArray(attachments) || attachments.length === 0 || attachments.length > 20) {
      throw new Error("Expected between 1 and 20 initial prompt attachments");
    }
    const environment = await context.storage.getEnvironment(environmentIdString);
    if (!environment) throw new Error(`Environment not found: ${environmentIdString}`);
    if (environment.worktreeMove)
      throw new Error("Move recovery is pending. Restart Orkestrator before staging attachments.");
    if (environment.environmentType === "local" && !environment.worktreePath) {
      throw new Error("Local environment worktree is not available");
    }
    if (environment.environmentType !== "local" && !environment.containerId) {
      throw new Error("Container environment is not ready");
    }

    const usedNames = new Set<string>();
    const batchId = randomUUID();
    const batchRelativeDirectory = `${INITIAL_PROMPT_STAGING_DIRECTORY}/${batchId}`;
    const saved: Array<{ name: string; path: string }> = [];
    const allocateName = (rawName: unknown): string => {
      const trimmed = asString(rawName, "attachment.name").trim() || "clipboard.png";
      const sanitizedName = trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
      // Match the other prompt-attachment staging path. Keeping this well
      // below NAME_MAX leaves room for collision suffixes on every supported
      // filesystem rather than turning a valid batch into ENAMETOOLONG.
      const boundedName = sanitizedName.slice(0, 128);
      const sanitized =
        boundedName === "." || boundedName === ".." || boundedName.length === 0
          ? "clipboard.png"
          : boundedName;
      const dot = sanitized.lastIndexOf(".");
      const stem = dot > 0 ? sanitized.slice(0, dot) : sanitized;
      const extension = dot > 0 ? sanitized.slice(dot) : "";
      let candidate = sanitized;
      let suffix = 2;
      while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${stem}-${suffix}${extension}`;
        suffix += 1;
      }
      usedNames.add(candidate.toLowerCase());
      return candidate;
    };

    // Validate and size-check the complete batch before creating any files. A
    // malformed later item must not turn validation into a partial filesystem
    // transaction that cleanup then has to infer. Whitespace is stripped exactly
    // once here; the per-item write reuses the normalized payload.
    let totalDecodedBytes = 0;
    const parsedAttachments = attachments.map((rawAttachment) => {
      // Each item was strict (`assertOnlyKeys`) before plan item 7002; an
      // unknown key is ignored now (§11.4).
      const attachment = asRecord(rawAttachment, "attachment");
      asNonBlankString(attachment.id, "attachment.id");
      const name = allocateName(attachment.name);
      const data = assertBase64PayloadWithinLimit(
        asString(attachment.base64Data, "attachment.base64Data"),
        { rejectEmpty: true },
      );
      // The per-item cap alone lets 20 attachments carry ~160MB of decoded
      // payload, all of it retained by this array before the first write.
      totalDecodedBytes += base64DecodedByteLength(data);
      if (totalDecodedBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        throw new Error(
          `Initial prompt attachments exceed the ${MAX_TOTAL_ATTACHMENT_BYTES} byte total limit`,
        );
      }
      return {
        name,
        data,
        relativePath: `${batchRelativeDirectory}/${name}`,
      };
    });

    // Best effort: a prune failure must never fail the write the user asked for.
    await (
      environment.environmentType === "local"
        ? pruneLocalInitialPromptBatches(environment.worktreePath!)
        : dockerExec(environment.containerId!, containerPruneInitialPromptBatchesCommand()).then(
            () => undefined,
          )
    ).catch(() => undefined);

    try {
      for (const { name, data, relativePath } of parsedAttachments) {
        let resolvedPath: string;
        if (environment.environmentType === "local") {
          resolvedPath = await writeConfinedLocalArtifact(
            environment.worktreePath!,
            relativePath,
            Buffer.from(data, "base64"),
          );
        } else {
          const fullPath = workspaceFilePath(relativePath);
          await runContainerWrite(
            environment.containerId!,
            [
              "node",
              "-e",
              CONTAINER_PINNED_ATTACHMENT_WRITE,
              "/workspace",
              batchRelativeDirectory,
              name,
              String(base64DecodedByteLength(data)),
            ],
            data,
          );
          resolvedPath = fullPath;
        }
        saved.push({ name, path: resolvedPath });
      }
      return saved;
    } catch (error) {
      if (environment.environmentType === "local") {
        // Remove only this request's unpredictable batch. Concurrent prompt
        // writes own different directories and cannot delete each other's files.
        // The whole chain is non-throwing: a cleanup failure must not replace
        // the failure the caller is actually being told about.
        await removeConfinedDirectory(environment.worktreePath!, batchRelativeDirectory).catch(
          () => undefined,
        );
      } else {
        await dockerExec(
          environment.containerId!,
          containerRemoveInitialPromptBatchCommand(batchRelativeDirectory),
        ).catch(() => undefined);
      }
      throw error;
    }
  };
  register(writeInitialPromptAttachmentsCommand, (args, context) => {
    const release = context.runtime.environments.fence.beginMutation(args.environmentId);
    return writeInitialPromptAttachments(args, context).finally(release);
  });
}
