import type {
  CoordinatorSnapshot,
  ProjectGitStatus,
  ProjectGitSwitchConfirmation,
  ProjectGitSwitchOptions,
} from "@orkestrator/protocol/coordinator";
import {
  parseCoordinatorActivitySnapshot,
  parseCoordinatorCheckoutTurn,
  type CoordinatorActivitySnapshot,
  type CoordinatorCheckoutTurn,
} from "@orkestrator/protocol/coordinator-activity";
import {
  parseCoordinatorLaunchOverrides,
  type CoordinatorLaunchOverridesSnapshot,
} from "@orkestrator/protocol/coordinator-launch-overrides";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { coordinatorApi as coordinatorDomainApi } from "@/lib/node-scope/domains/coordinator";
import { commandBackendClient, type BackendClient } from "./client";

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
  // The `coordinator` domain client (plan item 7009): version 1 sends the
  // envelope and decodes results; version 0 is today's untyped call.
  const domain = () => coordinatorDomainApi(client);

  /**
   * `keepConversationErrors`: this panel offers Retry for a conversation that
   * failed to start, so opening it must not clear the failure. An older backend
   * ignores the argument.
   */
  const ensureProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
    domain().ensure_project_coordinator({ projectId, keepConversationErrors: true });

  /** Clears a conversation's startup failure so its pane can connect again. */
  const retryCoordinatorConversation = (
    projectId: string,
    conversationId: string,
  ): Promise<CoordinatorSnapshot> =>
    domain().retry_coordinator_conversation({ projectId, conversationId });

  /**
   * Conditional coordinator read. With `known` (the stamp of the body this
   * client holds) the backend answers `unchanged` without a body while that body
   * is still current. Older backends answer "Unknown backend command".
   */
  const getProjectCoordinatorView = (
    projectId: string,
    known: ViewRevisionStamp | null,
  ): Promise<unknown> =>
    domain().get_project_coordinator_view({
      projectId,
      ...(known ? { knownGeneration: known.generation, knownRevision: known.revision } : {}),
    });

  /** Every project whose coordinator is working or waiting. Older backends answer "Unknown backend command". */
  const listCoordinatorActivity = (): Promise<CoordinatorActivitySnapshot> =>
    domain()
      .list_coordinator_activity(undefined as never)
      .then(parseCoordinatorActivitySnapshot);

  /** Worker tabs whose launch overrode the default. Older backends answer "Unknown backend command". */
  const listCoordinatorLaunchOverrides = (): Promise<CoordinatorLaunchOverridesSnapshot> =>
    domain()
      .list_coordinator_launch_overrides(undefined as never)
      .then(parseCoordinatorLaunchOverrides);

  /** The turn holding this project's checkout. Older backends answer "Unknown backend command". */
  const getCoordinatorCheckoutTurn = (projectId: string): Promise<CoordinatorCheckoutTurn | null> =>
    domain().get_coordinator_checkout_turn({ projectId }).then(parseCoordinatorCheckoutTurn);

  /**
   * `closeUnused` names unassigned side agents whose composer is empty here; the
   * backend closes those it agrees were never used.
   */
  const createCoordinatorConversation = (
    projectId: string,
    title?: string,
    closeUnused?: readonly string[],
  ): Promise<CoordinatorSnapshot> =>
    domain().create_coordinator_conversation({
      projectId,
      title,
      ...(closeUnused?.length ? { closeUnused } : {}),
    });

  const assignCoordinatorConversationAgent = (
    projectId: string,
    conversationId: string,
    agent: AgentPlatform,
  ): Promise<CoordinatorSnapshot> =>
    domain().assign_coordinator_conversation_agent({ projectId, conversationId, agent });

  const selectCoordinatorConversation = (
    projectId: string,
    conversationId: string | null,
  ): Promise<CoordinatorSnapshot> =>
    domain().select_coordinator_conversation({ projectId, conversationId });

  const closeCoordinatorConversation = (
    projectId: string,
    conversationId: string,
  ): Promise<CoordinatorSnapshot> =>
    domain().close_coordinator_conversation({ projectId, conversationId });

  const pauseProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
    domain().pause_project_coordinator({ projectId });

  const resumeProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
    domain().resume_project_coordinator({ projectId });

  const getProjectGitStatus = (projectId: string): Promise<ProjectGitStatus> =>
    domain().get_project_git_status({ projectId });

  const fetchProjectGit = (projectId: string, force = false): Promise<ProjectGitStatus> =>
    domain().fetch_project_git({ projectId, force });

  const syncProjectGit = (projectId: string): Promise<ProjectGitStatus> =>
    domain().sync_project_git({ projectId });

  const prepareProjectGitBranchSwitch = (
    projectId: string,
    ref: string,
  ): Promise<ProjectGitSwitchConfirmation> =>
    domain().prepare_project_git_branch_switch({ projectId, ref });

  const switchProjectGitBranch = (
    projectId: string,
    ref: string,
    options: boolean | ProjectGitSwitchOptions = {},
  ): Promise<ProjectGitStatus> =>
    domain().switch_project_git_branch({
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
    domain().write_coordinator_attachment({ environmentId, filename, base64Data });

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
    // The schema reads `reason` as a string (a newer backend may add one); the
    // web's type names today's reasons.
    domain().watch_coordinator_pull_request({
      projectId,
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      source,
    }) as Promise<CoordinatorPullRequestWatchResult>;

  return {
    ensureProjectCoordinator,
    retryCoordinatorConversation,
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
