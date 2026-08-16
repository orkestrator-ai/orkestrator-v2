import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { path, randomUUID, pathExists, readFileBase64, readTextFile, spawnCommand, writeFileBase64, assertBase64PayloadWithinLimit, base64DecodedByteLength, MAX_BINARY_FILE_BYTES, removeConfinedDirectory, validateRelativeFilePath, workspaceFilePath, INITIAL_PROMPT_STAGING_DIRECTORY, MAX_TOTAL_ATTACHMENT_BYTES } from "./commands-dependencies.js";
import type { EnvironmentDiffStatsSnapshot } from "./commands-dependencies.js";
import { terminalProcesses, terminalSessionConfigs, terminalOutputBuffers, terminalOutputRevisions, terminalOutputGenerations, terminalOutputDeltas, terminalOutputTruncated, CONTAINER_INTERACTIVE_SHELL_COMMAND, CONTAINER_SAFE_BASE64_READER, DIFF_CACHE_MAX_AGE_MS, diffStatsService, syncDiffStatsTracking, asString, asRecord, assertOnlyKeys, asOptionalString, asBoolean, asNumber, asTerminalDimension, asNonBlankString, quoteShell, validateGitRefName, envWithManagedBinaries, createEnvironmentCommandRunner, parseGitPorcelainPaths, findEnvironmentByContainerId, conditionalSnapshot, readTerminalOutputBuffer, logSetupTerminal, resolveLocalShellPath, rememberTerminalSession, isTerminalBootstrapped, stableTerminalKey, rememberStableTerminalSession, existingStableTerminalSession, containerTerminalConfigMatches, localTerminalConfigMatches, recordTerminalInputActivity, trackedTerminalActivityHooks, explicitlyCloseTerminalSession, terminalStableKeyEnvironmentId, assertEnvironmentNotDeleting, assertEnvironmentDeletionNotRequested, spawnTerminalProcess, getWorktreeBaseDir, isSetupTerminalSessionId, isTerminalSessionAttachable, dockerExec, buildFileTree, buildContainerGitStatusScript, isMissingTargetRefResponse, parseContainerGitStatusResponse, getLocalGitStatus, getContainerGitStatusDetailed, validateWorkspaceMutationPath, pruneLocalInitialPromptBatches, containerPruneInitialPromptBatchesCommand, CONTAINER_PINNED_ATTACHMENT_WRITE, containerRemoveInitialPromptBatchCommand, writeConfinedLocalArtifact, revertLocalFile, deleteLocalFile, requireLocalMutationEnvironment, requireContainerMutationEnvironment, containerRevertFileCommand, containerDeleteFileCommand, readLocalFileAtBranch } from "./commands-helpers.js";
import type { GitFileChange } from "./commands-helpers.js";

export function registerTerminalCommands(
  register: CommandRegistrar,
  _dependencies: RegistryDependencies,
): void {
  register("create_terminal_session", async ({
    containerId,
    environmentId,
    terminalKey,
    cols,
    rows,
    user,
    trackEnvironmentActivity,
  }, { storage }) => {
    const resolvedContainerId = asString(containerId, "containerId");
    const requestedEnvironmentId = asOptionalString(environmentId);
    assertEnvironmentNotDeleting(requestedEnvironmentId);
    const requestedTerminalKey = asOptionalString(terminalKey);
    const shouldTrackActivity = asBoolean(trackEnvironmentActivity);
    const matchedEnvironment = shouldTrackActivity || requestedEnvironmentId
      ? findEnvironmentByContainerId(
          await storage.loadEnvironments(),
          resolvedContainerId,
        )
      : undefined;
    assertEnvironmentNotDeleting(requestedEnvironmentId ?? matchedEnvironment?.id);
    if (requestedEnvironmentId && matchedEnvironment?.id !== requestedEnvironmentId) {
      throw new Error("Terminal container is not associated with the requested environment");
    }
    const activityEnvironmentId = shouldTrackActivity
      ? matchedEnvironment?.id
      : undefined;
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
    const existingId = existingStableTerminalSession(stableKey);
    if (existingId && containerTerminalConfigMatches(existingId, config)) {
      return {
        sessionId: existingId,
        created: false,
        bootstrapped: isTerminalBootstrapped(existingId),
      };
    }
    if (existingId) explicitlyCloseTerminalSession(existingId);

    const id = `${resolvedContainerId}:${randomUUID()}`;
    rememberStableTerminalSession(id, config, stableKey);
    return { sessionId: id, created: true, bootstrapped: false };
  });
  register("attach_terminal", ({ containerId, cols, rows, user }, { emit }) => {
    const id = `${asString(containerId, "containerId")}:${randomUUID()}`;
    const config = {
      kind: "container" as const,
      containerId: asString(containerId, "containerId"),
      cols: asTerminalDimension(cols, 80),
      rows: asTerminalDimension(rows, 24),
      user: asOptionalString(user),
    };
    rememberTerminalSession(id, config);
    const dockerArgs = ["exec", "-it"];
    if (config.user) dockerArgs.push("--user", config.user);
    dockerArgs.push(
      config.containerId,
      "bash",
      "-lc",
      CONTAINER_INTERACTIVE_SHELL_COMMAND,
    );
    spawnTerminalProcess(id, "docker", dockerArgs, config, emit);
    return id;
  });
  register("start_terminal_session", async ({ sessionId }, context) => {
    const { emit, storage } = context;
    const id = asString(sessionId, "sessionId");
    const storedConfig = terminalSessionConfigs.get(id);
    const config = storedConfig?.kind === "container" ? storedConfig : {
      kind: "container" as const,
      containerId: id.split(":")[0] ?? id,
      cols: 80,
      rows: 24,
    };
    const environmentId = config.environmentId
      ?? config.activityEnvironmentId
      ?? terminalStableKeyEnvironmentId(id)
      ?? undefined;
    assertEnvironmentNotDeleting(environmentId);
    if (environmentId) {
      const environment = await storage.getEnvironment(environmentId);
      assertEnvironmentNotDeleting(environmentId);
      assertEnvironmentDeletionNotRequested(environment, environmentId);
    }
    if (storedConfig && terminalSessionConfigs.get(id) !== storedConfig) {
      throw new Error("Container terminal session is no longer available");
    }
    const dockerArgs = ["exec", "-it"];
    if (config.user) dockerArgs.push("--user", config.user);
    dockerArgs.push(
      config.containerId,
      "bash",
      "-lc",
      CONTAINER_INTERACTIVE_SHELL_COMMAND,
    );
    spawnTerminalProcess(id, "docker", dockerArgs, config, emit, trackedTerminalActivityHooks(id, context));
  });
  // `delivered` is additive: HTTP callers ignore the result, while the terminal
  // WebSocket gateway needs it to avoid acknowledging input that never reached a
  // shell. Dropping it silently would tell the user a keystroke landed.
  register("terminal_write", ({ sessionId, data }, context) => {
    const id = asString(sessionId, "sessionId");
    const terminalData = asString(data, "data");
    const terminalProcess = terminalProcesses.get(id);
    if (!terminalProcess) return { delivered: false };
    terminalProcess.write(terminalData);
    recordTerminalInputActivity(id, terminalData, context);
    return { delivered: true };
  });
  register("terminal_resize", ({ sessionId, cols, rows }) => {
    const terminalProcess = terminalProcesses.get(asString(sessionId, "sessionId"));
    if (!terminalProcess) return { delivered: false };
    terminalProcess.resize(asTerminalDimension(cols, 80), asTerminalDimension(rows, 24));
    return { delivered: true };
  });
  register("detach_terminal", ({ sessionId }) => {
    explicitlyCloseTerminalSession(asString(sessionId, "sessionId"));
  });
  register("list_terminal_sessions", () => Array.from(terminalProcesses.keys()));
  register("get_terminal_session", ({ sessionId }) => {
    const id = asString(sessionId, "sessionId");
    const running = isTerminalSessionAttachable(id);
    if (isSetupTerminalSessionId(id)) {
      logSetupTerminal("renderer checked terminal session", {
        sessionId: id,
        running,
        terminalRunning: terminalProcesses.has(id),
        bufferChars: terminalOutputBuffers.get(id)?.length ?? 0,
      });
    }
    return { id, running, bootstrapped: isTerminalBootstrapped(id) };
  });
  register("bootstrap_terminal_session", ({ sessionId, data }, context) => {
    const id = asString(sessionId, "sessionId");
    const terminalData = asString(data, "data");
    if (isTerminalBootstrapped(id)) {
      return { bootstrapped: true, delivered: false, duplicate: true };
    }
    const terminalProcess = terminalProcesses.get(id);
    if (!terminalProcess) {
      return { bootstrapped: false, delivered: false, duplicate: false };
    }
    const config = terminalSessionConfigs.get(id);
    if (!config) return { bootstrapped: false, delivered: false, duplicate: false };
    config.bootstrapped = true;
    try {
      terminalProcess.write(terminalData);
      recordTerminalInputActivity(id, terminalData, context);
      return { bootstrapped: true, delivered: true, duplicate: false };
    } catch (error) {
      config.bootstrapped = false;
      throw error;
    }
  });
  register("get_terminal_output_buffer", ({ sessionId }) => {
    const id = asString(sessionId, "sessionId");
    const buffer = readTerminalOutputBuffer(id);
    if (isSetupTerminalSessionId(id)) {
      logSetupTerminal("renderer requested output buffer", {
        sessionId: id,
        bufferChars: buffer.length,
        running: terminalProcesses.has(id),
      });
    }
    return buffer;
  });
  register("get_terminal_output_snapshot", ({ sessionId, sinceRevision, sinceGeneration }) => {
    const id = asString(sessionId, "sessionId");
    const revision = terminalOutputRevisions.get(id) ?? 0;
    const generation = terminalOutputGenerations.get(id) ?? 0;
    if (sinceRevision !== undefined || sinceGeneration !== undefined) {
      const requestedRevision = asNumber(sinceRevision, "sinceRevision");
      const requestedGeneration = asNumber(sinceGeneration, "sinceGeneration");
      const deltas = terminalOutputDeltas.get(id) ?? [];
      const oldestRevision = deltas[0]?.revision ?? revision + 1;
      if (
        Number.isSafeInteger(requestedRevision)
        && requestedRevision >= 0
        && Number.isSafeInteger(requestedGeneration)
        && requestedGeneration === generation
        && requestedRevision <= revision
        && requestedRevision >= oldestRevision - 1
      ) {
        const retainedDeltas = deltas
          .filter((entry) => entry.revision > requestedRevision)
          .map((entry) => ({ revision: entry.revision, text: entry.text }));
        return {
          mode: "delta",
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
        mode: "full",
        reason: requestedGeneration === generation ? "expired" : "generation-changed",
        output: readTerminalOutputBuffer(id),
        revision,
        generation,
        truncated: terminalOutputTruncated.has(id),
      };
    }
    return {
      output: readTerminalOutputBuffer(id),
      revision,
      generation,
      truncated: terminalOutputTruncated.has(id),
    };
  });

  register("create_local_terminal_session", async ({
    environmentId,
    terminalKey,
    cols,
    rows,
    trackEnvironmentActivity,
  }, { storage }) => {
    const resolvedEnvironmentId = asString(environmentId, "environmentId");
    assertEnvironmentNotDeleting(resolvedEnvironmentId);
    const environment = await storage.getEnvironment(resolvedEnvironmentId);
    assertEnvironmentNotDeleting(resolvedEnvironmentId);
    assertEnvironmentDeletionNotRequested(environment, resolvedEnvironmentId);
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
    const existingId = existingStableTerminalSession(stableKey);
    if (existingId && localTerminalConfigMatches(existingId, config)) {
      return {
        sessionId: existingId,
        created: false,
        bootstrapped: isTerminalBootstrapped(existingId),
      };
    }
    if (existingId) explicitlyCloseTerminalSession(existingId);

    const id = `${resolvedEnvironmentId}:${randomUUID()}`;
    rememberStableTerminalSession(id, config, stableKey);
    return { sessionId: id, created: true, bootstrapped: false };
  });
  register("start_local_terminal_session", async ({ sessionId }, context) => {
    const { storage, emit } = context;
    const id = asString(sessionId, "sessionId");
    const storedConfig = terminalSessionConfigs.get(id);
    const config = storedConfig?.kind === "local" ? storedConfig : {
      kind: "local" as const,
      environmentId: id.split(":")[0] ?? id,
      cols: 80,
      rows: 24,
    };
    const environmentId = config.environmentId;
    assertEnvironmentNotDeleting(environmentId);
    const env = await storage.getEnvironment(environmentId);
    assertEnvironmentNotDeleting(environmentId);
    assertEnvironmentDeletionNotRequested(env, environmentId);
    if (!env?.worktreePath) throw new Error("Local environment worktree is not available");
    if (!await pathExists(env.worktreePath)) throw new Error(`Local environment worktree does not exist: ${env.worktreePath}`);
    assertEnvironmentNotDeleting(environmentId);
    const currentEnvironment = await storage.getEnvironment(environmentId);
    assertEnvironmentNotDeleting(environmentId);
    assertEnvironmentDeletionNotRequested(currentEnvironment, environmentId);
    if (!currentEnvironment?.worktreePath || currentEnvironment.worktreePath !== env.worktreePath) {
      throw new Error("Local environment worktree is no longer available");
    }
    if (storedConfig && terminalSessionConfigs.get(id) !== storedConfig) {
      throw new Error("Local terminal session is no longer available");
    }
    spawnTerminalProcess(
      id,
      resolveLocalShellPath(),
      ["-l"],
      {
        cwd: currentEnvironment.worktreePath,
        cols: config.cols,
        rows: config.rows,
        env: envWithManagedBinaries(context),
      },
      emit,
      trackedTerminalActivityHooks(id, context),
    );
  });
  register("local_terminal_write", ({ sessionId, data }, context) => {
    const id = asString(sessionId, "sessionId");
    const terminalData = asString(data, "data");
    const terminalProcess = terminalProcesses.get(id);
    if (!terminalProcess) return { delivered: false };
    terminalProcess.write(terminalData);
    recordTerminalInputActivity(id, terminalData, context);
    return { delivered: true };
  });
  register("local_terminal_resize", ({ sessionId, cols, rows }) => {
    const terminalProcess = terminalProcesses.get(asString(sessionId, "sessionId"));
    if (!terminalProcess) return { delivered: false };
    terminalProcess.resize(asTerminalDimension(cols, 80), asTerminalDimension(rows, 24));
    return { delivered: true };
  });
  register("close_local_terminal_session", ({ sessionId }) => {
    explicitlyCloseTerminalSession(asString(sessionId, "sessionId"));
  });

  register("get_local_git_status", async ({ worktreePath, targetBranch, includeUncommitted, knownDigest }) => {
    const resolvedWorktreePath = asString(worktreePath, "worktreePath");
    const ref = asString(targetBranch, "targetBranch");
    const includeWorkingTree = includeUncommitted !== false;
    if (!includeWorkingTree) {
      return conditionalSnapshot(
        await getLocalGitStatus(resolvedWorktreePath, ref, false),
        knownDigest,
      );
    }

    // The sidebar badge and the Files panel look at the same environment and used
    // to ask for it separately. Whichever arrives first pays for the scan.
    const cached = diffStatsService.cachedChanges({ worktreePath: resolvedWorktreePath }, ref, DIFF_CACHE_MAX_AGE_MS);
    if (cached) return conditionalSnapshot(cached as GitFileChange[], knownDigest);
    const changes = await getLocalGitStatus(resolvedWorktreePath, ref, true);
    diffStatsService.adoptScan({ worktreePath: resolvedWorktreePath }, ref, changes);
    return conditionalSnapshot(changes, knownDigest);
  });
  /**
   * Authoritative diff-stat snapshot.
   *
   * A client that mounts, remounts, or reconnects reads this rather than trying
   * to reconstruct state from the events it happened to be listening for. It
   * also arms tracking, so the first client to ask starts the work even if no
   * lifecycle command has run since the backend started.
   */
  register("get_environment_diff_stats", async (_args, context) => {
    await syncDiffStatsTracking(context);
    return { entries: diffStatsService.snapshot() } satisfies EnvironmentDiffStatsSnapshot;
  });
  register("refresh_environment_diff_stats", async ({ environmentId }, context) => {
    await syncDiffStatsTracking(context);
    diffStatsService.refresh(asString(environmentId, "environmentId"));
  });

  register("get_local_file_tree", async ({ worktreePath, knownDigest }) =>
    conditionalSnapshot(
      await buildFileTree(asString(worktreePath, "worktreePath")),
      knownDigest,
    )
  );
  register("read_local_file", ({ worktreePath, filePath }) => readTextFile(asString(worktreePath, "worktreePath"), asString(filePath, "filePath")));
  register("read_local_file_at_branch", ({ worktreePath, filePath, branch }) =>
    readLocalFileAtBranch(asString(worktreePath, "worktreePath"), asString(filePath, "filePath"), asString(branch, "branch")),
  );
  register("read_file_base64", ({ filePath }, context) =>
    readFileBase64(
      asString(filePath, "filePath"),
      [getWorktreeBaseDir(context)],
    )
  );
  register("write_local_file", ({ worktreePath, filePath, base64Data }) => writeFileBase64(asString(worktreePath, "worktreePath"), asString(filePath, "filePath"), asString(base64Data, "base64Data")));
  register("revert_local_file", async ({ environmentId, filePath, targetBranch }, context) => {
    const id = asString(environmentId, "environmentId");
    const environment = await requireLocalMutationEnvironment(context.storage, id);
    const result = await revertLocalFile(
      environment.worktreePath!,
      asString(filePath, "filePath"),
      asString(targetBranch, "targetBranch"),
    );
    diffStatsService.invalidateChanges({ worktreePath: environment.worktreePath! });
    diffStatsService.refresh(id);
    return result;
  });
  register("delete_local_file", async ({ environmentId, filePath }, context) => {
    const id = asString(environmentId, "environmentId");
    const environment = await requireLocalMutationEnvironment(context.storage, id);
    const result = await deleteLocalFile(environment.worktreePath!, asString(filePath, "filePath"));
    diffStatsService.invalidateChanges({ worktreePath: environment.worktreePath! });
    diffStatsService.refresh(id);
    return result;
  });

  register("get_git_status", async ({ containerId, targetBranch, includeUncommitted, knownDigest }) => {
    const ref = validateGitRefName(asString(targetBranch, "targetBranch"), "target branch");
    const includeWorkingTree = includeUncommitted !== false;
    const resolvedContainerId = asString(containerId, "containerId");

    if (includeWorkingTree) {
      const cached = diffStatsService.cachedChanges({ containerId: resolvedContainerId }, ref, DIFF_CACHE_MAX_AGE_MS);
      if (cached) return conditionalSnapshot(cached as GitFileChange[], knownDigest);
      const changes = (await getContainerGitStatusDetailed(resolvedContainerId, ref, true)).changes;
      diffStatsService.adoptScan({ containerId: resolvedContainerId }, ref, changes);
      return conditionalSnapshot(changes, knownDigest);
    }

    const output = await dockerExec(
      resolvedContainerId,
      buildContainerGitStatusScript(ref, includeWorkingTree),
    );
    // Distinguishes "the requested baseline is not in this container" - which
    // happens when a container is recreated from a different clone - from a
    // corrupt response, so callers do not see both as one opaque exec failure.
    if (isMissingTargetRefResponse(output)) {
      throw new Error(`Target ref is not present in the container: ${ref}`);
    }
    return conditionalSnapshot(
      parseContainerGitStatusResponse(output, includeWorkingTree),
      knownDigest,
    );
  });
  /**
   * Authoritative uncommitted-path list for one environment, for callers that
   * need the fact itself rather than a diff to render.
   *
   * The build pipeline reads this before and after writable validation stages.
   * Returning HEAD with the porcelain paths lets it reject both ordinary edits
   * and an agent-created commit before accepting a review or verification result.
   *
   * Scope is what Git reports and no more: tracked paths, plus untracked paths
   * Git does not ignore. Ignored files, anything under `.git/`, and paths
   * outside the worktree are invisible here, so no caller may describe this as
   * proof that the workspace was untouched.
   */
  register("get_environment_uncommitted_paths", async ({ environmentId }, context) => {
    const environment = await context.storage.getEnvironment(
      asString(environmentId, "environmentId"),
    );
    if (!environment) throw new Error("Environment not found");
    const runner = createEnvironmentCommandRunner(environment);
    const [head, output] = await Promise.all([
      runner("git", ["rev-parse", "--verify", "HEAD^{commit}"], 30_000),
      runner(
        "git",
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        30_000,
      ),
    ]);
    return { head: head.trim(), paths: parseGitPorcelainPaths(output) };
  });
  register("get_file_tree", async ({ containerId, knownDigest }) => {
    const output = await dockerExec(asString(containerId, "containerId"), "find /workspace -path /workspace/.git -prune -o -path /workspace/node_modules -prune -o -type l -prune -o -type f -printf '%P\\n' | head -5000");
    return conditionalSnapshot(
      output.split("\n").filter(Boolean).map((filePath) => ({ name: path.basename(filePath), path: filePath, isDirectory: false, extension: path.extname(filePath) })),
      knownDigest,
    );
  });
  register("read_container_file", async ({ containerId, filePath }) => {
    const target = validateRelativeFilePath(asString(filePath, "filePath"));
    const content = await dockerExec(asString(containerId, "containerId"), `cat ${quoteShell(workspaceFilePath(target))}`);
    return { path: target, content, language: path.extname(target).slice(1) };
  });
  register("read_file_at_branch", async ({ containerId, filePath, branch }) => {
    const target = validateRelativeFilePath(asString(filePath, "filePath"));
    const content = await dockerExec(asString(containerId, "containerId"), `git show ${quoteShell(asString(branch, "branch"))}:${quoteShell(target)} 2>/dev/null || true`);
    return content ? { path: target, content, language: path.extname(target).slice(1) } : null;
  });
  register("read_container_file_base64", async ({ containerId, filePath }) => {
    const fullPath = workspaceFilePath(asString(filePath, "filePath"));
    return (await dockerExec(
      asString(containerId, "containerId"),
      `node -e ${quoteShell(CONTAINER_SAFE_BASE64_READER)} -- /workspace ${quoteShell(fullPath)} ${MAX_BINARY_FILE_BYTES}`,
    )).trim();
  });
  register("write_container_file", async ({ containerId, filePath, base64Data }) => {
    const id = asString(containerId, "containerId");
    const target = validateRelativeFilePath(asString(filePath, "filePath"));
    const fullPath = workspaceFilePath(target);
    const directory = path.posix.dirname(fullPath);
    const data = asString(base64Data, "base64Data");
    assertBase64PayloadWithinLimit(data);
    await dockerExec(id, `mkdir -p ${quoteShell(directory)}`);
    const child = spawnCommand("docker", ["exec", "-i", id, "bash", "-lc", `base64 -d > ${quoteShell(fullPath)}`]);
    child.stdin.write(data);
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`docker exec exited with ${code}`)));
      child.once("error", reject);
    });
    return fullPath;
  });
  register("revert_container_file", async ({ environmentId, filePath, targetBranch }, context) => {
    const environmentIdString = asString(environmentId, "environmentId");
    const environment = await requireContainerMutationEnvironment(context.storage, environmentIdString);
    const id = environment.containerId!;
    const target = validateWorkspaceMutationPath(asString(filePath, "filePath"));
    const branch = validateGitRefName(asString(targetBranch, "targetBranch"), "target branch");
    await dockerExec(id, containerRevertFileCommand(target, branch));
    diffStatsService.invalidateChanges({ containerId: id });
    diffStatsService.refresh(environmentIdString);
    return target;
  });
  register("delete_container_file", async ({ environmentId, filePath }, context) => {
    const environmentIdString = asString(environmentId, "environmentId");
    const environment = await requireContainerMutationEnvironment(context.storage, environmentIdString);
    const id = environment.containerId!;
    const target = validateWorkspaceMutationPath(asString(filePath, "filePath"));
    await dockerExec(id, containerDeleteFileCommand(target));
    diffStatsService.invalidateChanges({ containerId: id });
    diffStatsService.refresh(environmentIdString);
    return target;
  });

  register("write_initial_prompt_attachments", async ({ environmentId, attachments }, context) => {
    const environmentIdString = asString(environmentId, "environmentId");
    if (!Array.isArray(attachments) || attachments.length === 0 || attachments.length > 20) {
      throw new Error("Expected between 1 and 20 initial prompt attachments");
    }
    const environment = await context.storage.getEnvironment(environmentIdString);
    if (!environment) throw new Error(`Environment not found: ${environmentIdString}`);
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
      const sanitized = boundedName === "." || boundedName === ".." || boundedName.length === 0
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
        const attachment = asRecord(rawAttachment, "attachment");
        assertOnlyKeys(attachment, ["id", "name", "base64Data"], "attachment");
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
    await (environment.environmentType === "local"
      ? pruneLocalInitialPromptBatches(environment.worktreePath!)
      : dockerExec(
          environment.containerId!,
          containerPruneInitialPromptBatchesCommand(),
        ).then(() => undefined)).catch(() => undefined);

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
          const child = spawnCommand("docker", [
            "exec", "-i", environment.containerId!, "node", "-e",
            CONTAINER_PINNED_ATTACHMENT_WRITE,
            "/workspace",
            batchRelativeDirectory,
            name,
            String(base64DecodedByteLength(data)),
          ]);
          await new Promise<void>((resolve, reject) => {
            child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`docker exec exited with ${code}`)));
            child.once("error", reject);
            child.stdin.on("error", (error: NodeJS.ErrnoException) => {
              if (error.code !== "EPIPE") reject(error);
            });
            child.stdin.end(data);
          });
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
        await removeConfinedDirectory(
          environment.worktreePath!,
          batchRelativeDirectory,
        ).catch(() => undefined);
      } else {
        await dockerExec(
          environment.containerId!,
          containerRemoveInitialPromptBatchCommand(batchRelativeDirectory),
        ).catch(() => undefined);
      }
      throw error;
    }
  });


}
