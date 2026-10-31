import { DOCKER_IMAGE } from "./constants.js";
import { runCommand } from "./shell.js";
import type { Environment } from "./models.js";
import { dockerExec, isContainerRunning } from "./commands-container-exec.js";
import type { CoordinatorConversation } from "@orkestrator/protocol/coordinator";
import {
  CONTAINER_WORKSPACE_PREPARE_COMMAND,
  CONTAINER_WORKSPACE_PREPARE_OK_SENTINEL,
  CONTAINER_WORKSPACE_PREPARE_SUPPORTED_SENTINEL,
  CONTAINER_WORKSPACE_PREPARE_SUPPORT_COMMAND,
} from "./container-scripts.js";
import { LOCAL_SERVER_KINDS } from "./local-server-runtime.js";
import type { LocalServerKind } from "./local-server-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { bugReportIdFromRuntimeId } from "@orkestrator/protocol/bug-report";
import {
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";

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
        `Rebuild it with \`mise run docker:build\` (${DOCKER_IMAGE}), then recreate this environment's container.`,
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

  return context.runtime.environments.joinBaselineCapture(environment.id, async () => {
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
  });
}

export async function ensureCreatedFromCommitBeforeSetup(
  environment: Environment,
  context: CommandContext,
  onPrepareOutput?: (chunk: string) => void,
): Promise<Environment> {
  if (environment.setupScriptsComplete || environment.createdFromCommit) return environment;
  return establishCreatedFromCommit(environment, context, onPrepareOutput);
}

export function localServerFields(kind: LocalServerKind): {
  port: keyof Environment;
  pid: keyof Environment;
} {
  if (kind === "opencode") return { port: "localOpencodePort", pid: "opencodePid" };
  if (kind === "claude") return { port: "localClaudePort", pid: "claudeBridgePid" };
  if (kind === "codex") return { port: "localCodexPort", pid: "codexBridgePid" };
  if (kind === "cursor") return { port: "localCursorPort", pid: "cursorBridgePid" };
  if (kind === "pi") return { port: "localPiPort", pid: "piBridgePid" };
  return { port: "localGrokPort", pid: "grokBridgePid" };
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
  const localServers = context.runtime.localServers;
  if (kind === "opencode") {
    localServers.openCodeAgentTools.cancel(`local:${environmentId}`);
  }
  const child = localServers.process(key);
  if (child) {
    context.nativeAgents?.runtimeStopRequested(environmentId);
    await localServers.terminate(key, child, "stop requested");
  }
  const { port, pid } = localServerFields(kind);
  const fields = { [port]: null, [pid]: null };
  const coordinatorId = coordinatorIdFromRuntimeId(environmentId);
  const bugReportId = bugReportIdFromRuntimeId(environmentId);
  if (bugReportId) {
    // A report keeps one bridge identity, for its own agent; stopping any
    // other kind has nothing to clear.
    const report = await context.storage.bugReports.getBugReport(bugReportId);
    if (report?.agent === kind) {
      await context.storage.bugReports.mutateBugReport(bugReportId, (current) => {
        const { bridgePort: _port, bridgePid: _pid, ...rest } = current;
        return rest;
      });
    }
  } else if (coordinatorId) {
    const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(coordinatorId);
    const conversationId = coordinatorConversationIdFromRuntimeId(environmentId);
    if (conversationId) {
      context.controlMcp?.revokeCoordinatorCredentials(coordinatorId, conversationId);
    }
    if (workspace && kind === "codex") {
      await context.storage.coordinators.mutateCoordinatorWorkspace(
        workspace.projectId,
        (current) =>
          current && current.id === coordinatorId
            ? {
                ...current,
                conversations: current.conversations.map((conversation) =>
                  conversation.id === conversationId
                    ? { ...conversation, bridgePort: undefined, bridgePid: undefined }
                    : conversation,
                ),
                updatedAt: new Date().toISOString(),
              }
            : current,
      );
    }
  } else {
    await context.storage.updateEnvironment(environmentId, fields);
  }
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

/** The Environment-shaped bridge identity for one coordinator conversation. */
export function coordinatorBridgeEnvironmentFields(
  conversation: Pick<CoordinatorConversation, "agent" | "bridgePort" | "bridgePid">,
): Partial<Environment> {
  if (!conversation.agent) return {};
  const { port, pid } = localServerFields(conversation.agent);
  return { [port]: conversation.bridgePort, [pid]: conversation.bridgePid } as Partial<Environment>;
}

/** The inverse: read whichever field pair this conversation's agent writes. */
export function coordinatorBridgeIdentityFromEnvironment(
  agent: CoordinatorConversation["agent"],
  fields: Partial<Environment>,
): { bridgePort?: number; bridgePid?: number } {
  if (!agent) return {};
  const { port, pid } = localServerFields(agent);
  const portValue = fields[port];
  const pidValue = fields[pid];
  return {
    bridgePort: typeof portValue === "number" ? portValue : undefined,
    bridgePid: typeof pidValue === "number" ? pidValue : undefined,
  };
}
