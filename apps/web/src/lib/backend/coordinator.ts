import type {
  CoordinatorSnapshot,
  ProjectGitStatus,
  ProjectGitSwitchConfirmation,
  ProjectGitSwitchOptions,
} from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_ACTIVITY_COMMAND,
  COORDINATOR_CHECKOUT_TURN_COMMAND,
  parseCoordinatorActivitySnapshot,
  parseCoordinatorCheckoutTurn,
  type CoordinatorActivitySnapshot,
  type CoordinatorCheckoutTurn,
} from "@orkestrator/protocol/coordinator-activity";
import {
  COORDINATOR_LAUNCH_OVERRIDES_COMMAND,
  parseCoordinatorLaunchOverrides,
  type CoordinatorLaunchOverridesSnapshot,
} from "@orkestrator/protocol/coordinator-launch-overrides";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { clientInvoke, commandBackendClient, type BackendClient } from "./client";

export const COORDINATOR_VIEW_COMMAND = "get_project_coordinator_view";

/** Why a pull request link a coordinator showed is, or is not, watched. */
export type CoordinatorPullRequestWatchResult =
  | { watched: true; added: boolean }
  | {
      watched: false;
      reason:
        "other-repository" | "no-repository" | "no-coordinator" | "settled" | "already-followed";
    };

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createCoordinatorApi(client: BackendClient) {
  const invoke = clientInvoke(client);

  /**
   * `keepConversationErrors`: this panel offers Retry for a conversation that
   * failed to start, so opening it must not clear the failure. An older backend
   * ignores the argument.
   */
  const ensureProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
    invoke("ensure_project_coordinator", { projectId, keepConversationErrors: true });

  /** Clears a conversation's startup failure so its pane can connect again. */
  const retryCoordinatorConversation = (
    projectId: string,
    conversationId: string,
  ): Promise<CoordinatorSnapshot> =>
    invoke("retry_coordinator_conversation", { projectId, conversationId });

  const getProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot | null> =>
    invoke("get_project_coordinator", { projectId });

  /**
   * Conditional coordinator read. With `known` (the stamp of the body this
   * client holds) the backend answers `unchanged` without a body while that body
   * is still current. Older backends answer "Unknown backend command".
   */
  const getProjectCoordinatorView = (
    projectId: string,
    known: ViewRevisionStamp | null,
  ): Promise<unknown> =>
    invoke(COORDINATOR_VIEW_COMMAND, {
      projectId,
      ...(known ? { knownGeneration: known.generation, knownRevision: known.revision } : {}),
    });

  /** Every project whose coordinator is working or waiting. Older backends answer "Unknown backend command". */
  const listCoordinatorActivity = (): Promise<CoordinatorActivitySnapshot> =>
    invoke<unknown>(COORDINATOR_ACTIVITY_COMMAND).then(parseCoordinatorActivitySnapshot);

  /** Worker tabs whose launch overrode the default. Older backends answer "Unknown backend command". */
  const listCoordinatorLaunchOverrides = (): Promise<CoordinatorLaunchOverridesSnapshot> =>
    invoke<unknown>(COORDINATOR_LAUNCH_OVERRIDES_COMMAND).then(parseCoordinatorLaunchOverrides);

  /** The turn holding this project's checkout. Older backends answer "Unknown backend command". */
  const getCoordinatorCheckoutTurn = (projectId: string): Promise<CoordinatorCheckoutTurn | null> =>
    invoke<unknown>(COORDINATOR_CHECKOUT_TURN_COMMAND, { projectId }).then(
      parseCoordinatorCheckoutTurn,
    );

  /**
   * `closeUnused` names unassigned side agents whose composer is empty here; the
   * backend closes those it agrees were never used.
   */
  const createCoordinatorConversation = (
    projectId: string,
    title?: string,
    closeUnused?: readonly string[],
  ): Promise<CoordinatorSnapshot> =>
    invoke("create_coordinator_conversation", {
      projectId,
      title,
      ...(closeUnused?.length ? { closeUnused } : {}),
    });

  const assignCoordinatorConversationAgent = (
    projectId: string,
    conversationId: string,
    agent: AgentPlatform,
  ): Promise<CoordinatorSnapshot> =>
    invoke("assign_coordinator_conversation_agent", { projectId, conversationId, agent });

  const selectCoordinatorConversation = (
    projectId: string,
    conversationId: string | null,
  ): Promise<CoordinatorSnapshot> =>
    invoke("select_coordinator_conversation", { projectId, conversationId });

  const closeCoordinatorConversation = (
    projectId: string,
    conversationId: string,
  ): Promise<CoordinatorSnapshot> =>
    invoke("close_coordinator_conversation", { projectId, conversationId });

  const pauseProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
    invoke("pause_project_coordinator", { projectId });

  const resumeProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
    invoke("resume_project_coordinator", { projectId });

  const getProjectGitStatus = (projectId: string): Promise<ProjectGitStatus> =>
    invoke("get_project_git_status", { projectId });

  const fetchProjectGit = (projectId: string, force = false): Promise<ProjectGitStatus> =>
    invoke("fetch_project_git", { projectId, force });

  const syncProjectGit = (projectId: string): Promise<ProjectGitStatus> =>
    invoke("sync_project_git", { projectId });

  const prepareProjectGitBranchSwitch = (
    projectId: string,
    ref: string,
  ): Promise<ProjectGitSwitchConfirmation> =>
    invoke("prepare_project_git_branch_switch", { projectId, ref });

  const switchProjectGitBranch = (
    projectId: string,
    ref: string,
    options: boolean | ProjectGitSwitchOptions = {},
  ): Promise<ProjectGitStatus> =>
    invoke("switch_project_git_branch", {
      projectId,
      ref,
      ...(typeof options === "boolean"
        ? {}
        : {
            confirmationToken: options.confirmationToken,
            includeNestedRepositories: options.includeNestedRepositories === true,
          }),
    });

  const writeCoordinatorAttachment = (
    environmentId: string,
    filename: string,
    base64Data: string,
  ): Promise<string> =>
    invoke("write_coordinator_attachment", { environmentId, filename, base64Data });

  /**
   * A coordinator conversation of `projectId` rendered or opened this pull
   * request: watch it for status changes while it is open. The backend ignores
   * pull requests of other repositories. Older backends answer "Unknown backend
   * command".
   */
  const watchCoordinatorPullRequest = (
    projectId: string,
    ref: { owner: string; repo: string; number: number },
    source: "rendered" | "opened",
  ): Promise<CoordinatorPullRequestWatchResult> =>
    invoke("watch_coordinator_pull_request", {
      projectId,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      source,
    });

  return {
    ensureProjectCoordinator,
    retryCoordinatorConversation,
    getProjectCoordinator,
    getProjectCoordinatorView,
    listCoordinatorActivity,
    listCoordinatorLaunchOverrides,
    getCoordinatorCheckoutTurn,
    createCoordinatorConversation,
    assignCoordinatorConversationAgent,
    selectCoordinatorConversation,
    closeCoordinatorConversation,
    pauseProjectCoordinator,
    resumeProjectCoordinator,
    getProjectGitStatus,
    fetchProjectGit,
    syncProjectGit,
    prepareProjectGitBranchSwitch,
    switchProjectGitBranch,
    writeCoordinatorAttachment,
    watchCoordinatorPullRequest,
  };
}

export type CoordinatorApi = ReturnType<typeof createCoordinatorApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  ensureProjectCoordinator,
  retryCoordinatorConversation,
  getProjectCoordinator,
  getProjectCoordinatorView,
  listCoordinatorActivity,
  listCoordinatorLaunchOverrides,
  getCoordinatorCheckoutTurn,
  createCoordinatorConversation,
  assignCoordinatorConversationAgent,
  selectCoordinatorConversation,
  closeCoordinatorConversation,
  pauseProjectCoordinator,
  resumeProjectCoordinator,
  getProjectGitStatus,
  fetchProjectGit,
  syncProjectGit,
  prepareProjectGitBranchSwitch,
  switchProjectGitBranch,
  writeCoordinatorAttachment,
  watchCoordinatorPullRequest,
} = createCoordinatorApi(commandBackendClient);
