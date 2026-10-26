import {
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";

import {
  activeAgentAccountShellEnvironment,
  stripInheritedAgentCredentials,
} from "./agent-accounts-active.js";
import { envWithManagedBinaries } from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  assertEnvironmentDeletionNotRequested,
  resolveLocalShellPath,
  terminalEnv,
} from "./commands-terminal.js";
import { asBoolean, asString } from "./commands-validation.js";
import { spawnPty } from "./pty.js";
import { UserCommandError, type UserCommandLaunch } from "./user-commands.js";

/**
 * Commands behind the composer's `!` prefix (see `user-commands.ts`).
 *
 * Only the composer calls these: they run a command *as the user*. They are
 * deliberately not reachable from the Control MCP or the agent tools, and the
 * agent dispatch path never interprets a leading `!` itself, so an agent
 * cannot use them to run something in a coordinator's checkout.
 */

const COLS = 120;
const ROWS = 40;

function service(context: CommandContext) {
  if (!context.userCommands) {
    throw new UserCommandError("unavailable", "User commands are not available on this backend.");
  }
  return context.userCommands;
}

/**
 * Where a tab's `!` commands run.
 *
 * - An environment tab: its workspace, as a terminal tab there would — the
 *   worktree with the user's login shell and managed binaries, or the
 *   container as the `node` user in `/workspace`.
 * - A coordinator conversation: the project's own checkout on this node, as
 *   the user. The coordinator's agent stays read-only; this is the person
 *   acting, the same as typing in a terminal there
 *   (docs/architecture/coordinator.md, "User `!` commands").
 */
export async function resolveUserCommandLaunch(
  context: CommandContext,
  environmentId: string,
): Promise<UserCommandLaunch> {
  const coordinatorId = coordinatorIdFromRuntimeId(environmentId);
  if (coordinatorId) {
    const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(coordinatorId);
    const conversationId = coordinatorConversationIdFromRuntimeId(environmentId);
    const conversation = workspace?.conversations.find(
      (item) => item.id === conversationId && !item.closedAt,
    );
    if (!workspace || !conversation) {
      throw new UserCommandError("unavailable", "This coordinator conversation is closed.");
    }
    const project = await context.storage.getProject(workspace.projectId);
    if (!project?.localPath) {
      throw new UserCommandError("unavailable", "This project has no checkout on this machine.");
    }
    return localLaunch(context, "project-checkout", project.localPath);
  }

  context.runtime.environments.assertNotDeleting(environmentId);
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new UserCommandError("unavailable", "That environment does not exist.");
  assertEnvironmentDeletionNotRequested(environment, environmentId);
  if (environment.environmentType === "local") {
    if (!environment.worktreePath) {
      throw new UserCommandError("unavailable", "The environment has no workspace yet.");
    }
    return localLaunch(context, "worktree", environment.worktreePath);
  }
  if (!environment.containerId || environment.status !== "running") {
    throw new UserCommandError("unavailable", "Start the environment's container first.");
  }
  const containerId = environment.containerId;
  return {
    target: "container",
    cwd: "/workspace",
    spawn: (command) =>
      spawnPty(
        "docker",
        ["exec", "-it", "-u", "node", "-w", "/workspace", containerId, "bash", "-lc", command],
        { cols: COLS, rows: ROWS, env: terminalEnv() },
      ),
  };
}

async function localLaunch(
  context: CommandContext,
  target: "worktree" | "project-checkout",
  cwd: string,
): Promise<UserCommandLaunch> {
  // The same environment a terminal tab gets: the user's own, plus managed
  // binaries and the active agent accounts.
  const accounts = await activeAgentAccountShellEnvironment(context).catch(() => ({}));
  const env = { ...envWithManagedBinaries(context), ...accounts };
  if ("CLAUDE_CONFIG_DIR" in accounts || "CODEX_HOME" in accounts) {
    stripInheritedAgentCredentials(env);
  }
  const shell = resolveLocalShellPath();
  return {
    target,
    cwd,
    spawn: (command) =>
      spawnPty(shell, ["-lc", command], { cwd, cols: COLS, rows: ROWS, env: terminalEnv(env) }),
  };
}

export function registerUserCommandCommands(register: CommandRegistrar): void {
  register("run_user_command", async ({ environmentId, tabId, command }, context) =>
    service(context).run({
      environmentId: asString(environmentId, "environmentId"),
      tabId: asString(tabId, "tabId"),
      command: asString(command, "command"),
    }),
  );
  register("list_user_commands", ({ environmentId, tabId }, context) => {
    const environment = asString(environmentId, "environmentId");
    const tab = asString(tabId, "tabId");
    return {
      environmentId: environment,
      tabId: tab,
      commands: context.userCommands?.list(environment, tab) ?? [],
    };
  });
  register("write_user_command_input", ({ id, text, enter }, context) =>
    service(context).write(asString(id, "id"), typeof text === "string" ? text : "", {
      enter: asBoolean(enter, true),
    }),
  );
  register("cancel_user_command", async ({ id }, context) =>
    service(context).cancel(asString(id, "id")),
  );
  register("list_human_prompts", ({ environmentIds, tabId }, context) => ({
    prompts:
      context.humanPrompts?.list({
        ...(Array.isArray(environmentIds)
          ? {
              environmentIds: environmentIds
                .filter((value): value is string => typeof value === "string")
                .slice(0, 500),
            }
          : {}),
        ...(typeof tabId === "string" ? { tabId } : {}),
      }) ?? [],
  }));
}
