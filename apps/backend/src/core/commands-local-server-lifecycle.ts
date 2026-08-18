import { DOCKER_IMAGE, runCommand } from "./commands-dependencies.js";
import type { ChildProcessWithoutNullStreams, Environment } from "./commands-dependencies.js";
import { dockerExec, isContainerRunning } from "./commands-container-exec.js";
import {
  CONTAINER_WORKSPACE_PREPARE_COMMAND,
  CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL,
  CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL,
  CONTAINER_WORKSPACE_PREPARE_SUPPORT_COMMAND,
  LOCAL_SERVER_KILL_WAIT_MS,
  LOCAL_SERVER_KINDS,
  LOCAL_SERVER_SHUTDOWN_GRACE_MS,
  configuredOpenCodeAgentTools,
  environmentBaselineTasks,
  localClaudeBridgeTokens,
  localCodexBridgeTokens,
  localCursorBridgeTokens,
  localCursorCredentialFingerprints,
  localGrokBridgeTokens,
  localOpenCodeServerPasswords,
  localServerEnvironmentOperations,
  localServerProcesses,
  openCodeAgentToolsConfigurations,
  terminateProcessTreeImpl,
} from "./commands-runtime-state.js";
import type { LocalServerKind } from "./commands-runtime-state.js";
import type { CommandContext } from "./commands-context.js";

/**
 * Local agent-server process lifecycle and the environment's baseline commit.
 *
 * A leaf. `commands-environment` needs exactly these from the server module
 * and nothing else, so hosting them in `commands-servers` - which legitimately
 * depends on `commands-environment` for ownership and teardown - made the two
 * modules mutually dependent. Nothing here may import `commands-environment`
 * or `commands-servers`.
 */

export function parseHeadCommit(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  return /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed : undefined;
}

export async function readLocalHeadCommit(worktreePath: string): Promise<string> {
  const { stdout } = await runCommand(
    "git",
    ["-C", worktreePath, "rev-parse", "--verify", "HEAD^{commit}"],
    { timeoutMs: 30_000 },
  );
  const commit = parseHeadCommit(stdout);
  if (!commit) {
    throw new Error(`Git returned an invalid HEAD commit for ${worktreePath}`);
  }
  return commit;
}

export async function readContainerHeadCommit(containerId: string): Promise<string | undefined> {
  const commit = await dockerExec(
    containerId,
    "git -C /workspace rev-parse --verify 'HEAD^{commit}'",
    30_000,
  );
  return parseHeadCommit(commit);
}

export async function prepareContainerWorkspace(
  containerId: string,
  onOutput?: (chunk: string) => void,
): Promise<void> {
  const support = await dockerExec(
    containerId,
    CONTAINER_WORKSPACE_PREPARE_SUPPORT_COMMAND,
    60_000,
  );
  if (!support.includes(CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL)) {
    throw new Error(
      `Container base image is out of date and cannot prepare the workspace safely. ` +
        `Rebuild it with \`bun run docker:build\` (${DOCKER_IMAGE}), then recreate this environment's container.`,
    );
  }

  const output = await dockerExec(containerId, CONTAINER_WORKSPACE_PREPARE_COMMAND, 10 * 60_000);
  onOutput?.(output);
  if (!output.includes(CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL)) {
    throw new Error(`Workspace preparation did not report completion for container ${containerId}`);
  }
}

/**
 * Resolves and durably stores the commit an environment branched from.
 *
 * `onPrepareOutput` only fires for the caller that actually starts the work; a
 * caller that joins an in-flight capture gets the result but not the output,
 * because the output already belongs to the first caller's setup terminal.
 */
export async function establishCreatedFromCommit(
  environment: Environment,
  context: CommandContext,
  onPrepareOutput?: (chunk: string) => void,
): Promise<Environment> {
  if (environment.createdFromCommit) return environment;

  const existing = environmentBaselineTasks.get(environment.id);
  if (existing) return existing;

  const task = (async () => {
    const current = (await context.storage.getEnvironment(environment.id)) ?? environment;
    if (current.createdFromCommit) return current;

    let commit: string | undefined;
    if (current.environmentType === "local") {
      if (!current.worktreePath) {
        throw new Error(`Local environment worktree is not available: ${current.id}`);
      }
      commit = await readLocalHeadCommit(current.worktreePath);
    } else {
      if (!current.containerId) {
        throw new Error(`Environment has no container: ${current.id}`);
      }
      if (!(await isContainerRunning(current.containerId))) {
        throw new Error(`Container is not running: ${current.containerId}`);
      }
      await prepareContainerWorkspace(current.containerId, onPrepareOutput);
      commit = await readContainerHeadCommit(current.containerId);
    }

    if (!commit) {
      throw new Error(`Could not resolve environment creation commit: ${current.id}`);
    }
    return context.storage.updateEnvironment(current.id, { createdFromCommit: commit });
  })().finally(() => {
    if (environmentBaselineTasks.get(environment.id) === task) {
      environmentBaselineTasks.delete(environment.id);
    }
  });
  environmentBaselineTasks.set(environment.id, task);
  return task;
}

export async function ensureCreatedFromCommitBeforeSetup(
  environment: Environment,
  context: CommandContext,
  onPrepareOutput?: (chunk: string) => void,
): Promise<Environment> {
  if (environment.setupScriptsComplete || environment.createdFromCommit) return environment;
  return establishCreatedFromCommit(environment, context, onPrepareOutput);
}

export function enqueueLocalServerEnvironmentOperation<T>(
  environmentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = localServerEnvironmentOperations.get(environmentId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  localServerEnvironmentOperations.set(environmentId, tail);
  void tail.finally(() => {
    if (localServerEnvironmentOperations.get(environmentId) === tail) {
      localServerEnvironmentOperations.delete(environmentId);
    }
  });
  return result;
}

export function localServerFields(kind: LocalServerKind): {
  port: keyof Environment;
  pid: keyof Environment;
} {
  if (kind === "opencode") return { port: "localOpencodePort", pid: "opencodePid" };
  if (kind === "claude") return { port: "localClaudePort", pid: "claudeBridgePid" };
  if (kind === "codex") return { port: "localCodexPort", pid: "codexBridgePid" };
  if (kind === "cursor") return { port: "localCursorPort", pid: "cursorBridgePid" };
  return { port: "localGrokPort", pid: "grokBridgePid" };
}

export function releaseLocalServerOwnership(
  key: string,
  child: ChildProcessWithoutNullStreams,
): void {
  if (localServerProcesses.get(key) !== child) return;
  localServerProcesses.delete(key);
  if (key.startsWith("codex:")) {
    localCodexBridgeTokens.delete(key.slice("codex:".length));
  } else if (key.startsWith("claude:")) {
    localClaudeBridgeTokens.delete(key.slice("claude:".length));
  } else if (key.startsWith("opencode:")) {
    const environmentId = key.slice("opencode:".length);
    localOpenCodeServerPasswords.delete(environmentId);
    cancelOpenCodeAgentToolsConfiguration(`local:${environmentId}`);
  } else if (key.startsWith("cursor:")) {
    const environmentId = key.slice("cursor:".length);
    localCursorBridgeTokens.delete(environmentId);
    localCursorCredentialFingerprints.delete(environmentId);
  } else if (key.startsWith("grok:")) {
    localGrokBridgeTokens.delete(key.slice("grok:".length));
  }
}

export async function terminateLocalServerChild(
  key: string,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const exited = await terminateProcessTreeImpl(child, {
    graceMs: LOCAL_SERVER_SHUTDOWN_GRACE_MS,
    killWaitMs: LOCAL_SERVER_KILL_WAIT_MS,
  });
  if (!exited) {
    // Keep the ownership entry so shutdown or a retry can target it again.
    // Forgetting a process that is still alive recreates the orphan leak.
    throw new Error(`Local server process tree did not exit: ${key}`);
  }
  releaseLocalServerOwnership(key, child);
}

export function cancelOpenCodeAgentToolsConfiguration(key: string): void {
  openCodeAgentToolsConfigurations.get(key)?.controller.abort();
  openCodeAgentToolsConfigurations.delete(key);
  configuredOpenCodeAgentTools.delete(key);
}

export function aggregateRejectedResults(
  results: PromiseSettledResult<unknown>[],
  message: string,
): void {
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, message);
}

export async function stopLocalServerUnlocked(
  environmentId: string,
  context: CommandContext,
  kind: LocalServerKind,
): Promise<void> {
  const key = `${kind}:${environmentId}`;
  if (kind === "opencode") {
    cancelOpenCodeAgentToolsConfiguration(`local:${environmentId}`);
  }
  const child = localServerProcesses.get(key);
  if (child) await terminateLocalServerChild(key, child);
  const { port, pid } = localServerFields(kind);
  const fields = { [port]: null, [pid]: null };
  await context.storage.updateEnvironment(environmentId, fields);
}

export async function stopLocalServersForEnvironmentUnlocked(
  environmentId: string,
  context: CommandContext,
): Promise<void> {
  const results = await Promise.allSettled(
    LOCAL_SERVER_KINDS.map((kind) => stopLocalServerUnlocked(environmentId, context, kind)),
  );
  aggregateRejectedResults(
    results,
    `Failed to stop all local servers for environment: ${environmentId}`,
  );
}
