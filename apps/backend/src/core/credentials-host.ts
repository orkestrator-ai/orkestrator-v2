import { CREDENTIAL_ANY_TAB } from "@orkestrator/protocol/agent-credentials";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { stat } from "node:fs/promises";
import {
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";
import {
  activeAgentAccountShellEnvironment,
  stripInheritedAgentCredentials,
} from "./agent-accounts/index.js";
import { envWithManagedBinaries } from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import {
  assertEnvironmentDeletionNotRequested,
  resolveLocalShellPath,
  terminalEnv,
} from "./commands-terminal.js";
import type {
  CredentialHost,
  CredentialLaunch,
  CredentialRuntimeInfo,
  CredentialSessionInfo,
} from "./credentials/index.js";
import type { Environment, PersistedNativeAgentSession } from "./models.js";
import { resolveEnvironmentExecutionPolicy } from "./native-agent/index.js";
import { paneLayoutLeaves } from "./storage-shared-pane-layout.js";
import { nativeAgentSessionStorageKey } from "./native-agent/service-shared.js";
import { localEnvironmentIsolationEnv, withEnvironmentIsolation } from "./environment-isolation.js";

/**
 * The credential service's view of the backend (credentials/context.ts):
 * which conversation a tab runs, where its environment's agent runs, and how
 * to start a command there. Every answer comes from the backend's records,
 * never from the agent.
 *
 * Commands run where the tab's own agent runs, exactly as a `!` command
 * would (`commands-registry-user-commands.ts`): the worktree with the user's
 * login shell, managed binaries and isolation variables, or the container as
 * the `node` user in `/workspace`. A coordinator conversation never runs one.
 */

class CredentialLaunchError extends Error {}

export function createCredentialHost(context: CommandContext): CredentialHost {
  return {
    async hasApprovalTab(environmentId, tabId) {
      const layout = await context.storage.getPaneLayout(environmentId);
      const environment = context.storage.readEnvironmentRow(environmentId);
      return Boolean(
        environment &&
        paneLayoutLeaves(layout?.root).some((leaf) =>
          leaf.tabs.some(
            (tab) =>
              typeof tab.id === "string" &&
              (tabId === CREDENTIAL_ANY_TAB || tab.id === tabId) &&
              tab.type === "agent-native" &&
              !environment.tabTeardownIntents?.[tab.id],
          ),
        ),
      );
    },

    async session(environmentId, tabId) {
      const logicalSessionKey = `env-${environmentId}:${tabId}`;
      const session = (await context.storage.readNativeAgentSessionsSnapshot()).find(
        (candidate) =>
          candidate.environmentId === environmentId &&
          candidate.logicalSessionKey === logicalSessionKey,
      );
      const environment = session?.policy
        ? null
        : await context.storage.getEnvironment(environmentId);
      return sessionInfo(session, environment) ?? environmentSessionInfo(environment);
    },

    async runtime(environmentId) {
      const coordinatorId = coordinatorIdFromRuntimeId(environmentId);
      if (coordinatorId) {
        const workspace =
          await context.storage.coordinators.getCoordinatorWorkspaceById(coordinatorId);
        const conversationId = coordinatorConversationIdFromRuntimeId(environmentId);
        if (
          !workspace?.conversations.some((item) => item.id === conversationId && !item.closedAt)
        ) {
          return null;
        }
        const project = await context.storage.getProject(workspace.projectId);
        return {
          runtime: { kind: "coordinator", isolation: "read-only" },
          networkAccess: "restricted",
          identity: `coordinator:${project?.localPath ?? workspace.projectId}`,
        };
      }
      return runtimeInfo(await context.storage.getEnvironment(environmentId));
    },

    dispatchBinding(environmentId, tabId, agent) {
      context.runtime.environments.assertNotDeleting(environmentId);
      context.runtime.environments.fence.assertAcceptsAgentWork(environmentId);
      const environment = context.storage.readEnvironmentRow(environmentId);
      const session = isAgentPlatform(agent)
        ? context.storage.peekNativeAgentSession(
            nativeAgentSessionStorageKey(environmentId, agent, `env-${environmentId}:${tabId}`),
          )
        : undefined;
      if (environment?.tabTeardownIntents?.[tabId]) return { session: null, runtime: null };
      return {
        session: sessionInfo(session, environment) ?? environmentSessionInfo(environment),
        runtime: runtimeInfo(environment),
      };
    },

    async beginUse(environmentId, tabId) {
      const release = context.runtime.environments.fence.beginAgentWork(environmentId);
      try {
        const environment = await context.storage.getEnvironment(environmentId);
        context.runtime.environments.assertNotDeleting(environmentId);
        context.runtime.environments.fence.assertAcceptsAgentWork(environmentId);
        if (
          !environment ||
          environment.deletionRequestedAt ||
          environment.tabTeardownIntents?.[tabId] ||
          environment.worktreeMove ||
          environment.lifecycleOperation ||
          environment.status === "stopping"
        ) {
          throw new CredentialLaunchError("The environment or tab is changing.");
        }
        return release;
      } catch (error) {
        release();
        throw error;
      }
    },

    async launch(environmentId, tabId) {
      if (coordinatorIdFromRuntimeId(environmentId)) {
        throw new CredentialLaunchError("A coordinator conversation cannot run commands.");
      }
      const release = context.runtime.environments.fence.beginAgentWork(environmentId);
      try {
        context.runtime.environments.assertNotDeleting(environmentId);
        const environment = await context.storage.getEnvironment(environmentId);
        if (!environment) throw new CredentialLaunchError("That environment no longer exists.");
        assertEnvironmentDeletionNotRequested(environment, environmentId);
        if (environment.tabTeardownIntents?.[tabId]) {
          throw new CredentialLaunchError("This tab is closing.");
        }
        if (
          environment.worktreeMove ||
          environment.lifecycleOperation ||
          environment.status === "stopping" ||
          environment.status === "creating"
        ) {
          throw new CredentialLaunchError("This environment has a pending lifecycle operation.");
        }
        let launch: CredentialLaunch;
        if (environment.environmentType === "local") {
          const cwd = environment.worktreePath;
          if (!cwd || !(await stat(cwd).catch(() => null))?.isDirectory()) {
            throw new CredentialLaunchError("The environment has no workspace.");
          }
          const accounts = await activeAgentAccountShellEnvironment(context).catch(() => ({}));
          const env = {
            ...withEnvironmentIsolation(
              envWithManagedBinaries(context),
              await localEnvironmentIsolationEnv(environment, context.storage),
            ),
            ...accounts,
          };
          if ("CLAUDE_CONFIG_DIR" in accounts || "CODEX_HOME" in accounts) {
            stripInheritedAgentCredentials(env);
          }
          launch = {
            target: "worktree",
            cwd,
            env: terminalEnv(env),
            shell: resolveLocalShellPath(),
          };
        } else {
          if (!environment.containerId || environment.status !== "running") {
            throw new CredentialLaunchError("Start the environment's container first.");
          }
          launch = {
            target: "container",
            cwd: "/workspace",
            containerId: environment.containerId,
            env: terminalEnv(withEnvironmentIsolation(process.env)),
          };
        }
        // No await between this check and the caller's spawn but the
        // credential recheck, which is synchronous.
        context.runtime.environments.assertNotDeleting(environmentId);
        context.runtime.environments.fence.assertAcceptsAgentWork(environmentId);
        return { ...launch, release };
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}

function sessionInfo(
  session: PersistedNativeAgentSession | undefined,
  environment: Environment | null,
): CredentialSessionInfo | null {
  if (!session) return null;
  return {
    agent: session.agent,
    logicalSessionKey: session.logicalSessionKey,
    providerSessionId: session.providerSessionId || null,
    policy:
      session.policy ??
      (session.executionPolicy === "coordinator-read-only"
        ? {
            id: "coordinator-read-only",
            sandbox: "provider",
            approvals: "deny",
            projectResources: false,
            networkAccess: "restricted",
          }
        : environment
          ? resolveEnvironmentExecutionPolicy(environment, session.origin)
          : null),
  };
}

/**
 * The policy for a caller with no session record of its own: OpenCode's
 * environment-wide connection, or a tab whose record is not written yet. The
 * environment's interactive policy applies, never "no policy".
 */
function environmentSessionInfo(environment: Environment | null): CredentialSessionInfo | null {
  if (!environment) return null;
  return {
    agent: null,
    logicalSessionKey: "",
    providerSessionId: null,
    policy: resolveEnvironmentExecutionPolicy(environment, "interactive-native"),
  };
}

function runtimeInfo(environment: Environment | null): CredentialRuntimeInfo | null {
  if (
    !environment ||
    environment.deletionRequestedAt ||
    environment.worktreeMove ||
    environment.lifecycleOperation ||
    environment.status === "stopping"
  )
    return null;
  if (environment.environmentType === "local") {
    return environment.worktreePath
      ? {
          runtime: { kind: "worktree", isolation: "trusted-local" },
          identity: `worktree:${environment.worktreePath}`,
        }
      : null;
  }
  return environment.containerId && environment.status === "running"
    ? {
        runtime: { kind: "container", isolation: "shared-container" },
        networkAccess: environment.networkAccessMode,
        identity: `container:${environment.containerId}`,
      }
    : null;
}
