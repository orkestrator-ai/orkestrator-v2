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
import { invoke } from "@/lib/native/backend";

/**
 * `keepConversationErrors`: this panel offers Retry for a conversation that
 * failed to start, so opening it must not clear the failure. An older backend
 * ignores the argument.
 */
export const ensureProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
  invoke("ensure_project_coordinator", { projectId, keepConversationErrors: true });

/** Clears a conversation's startup failure so its pane can connect again. */
export const retryCoordinatorConversation = (
  projectId: string,
  conversationId: string,
): Promise<CoordinatorSnapshot> =>
  invoke("retry_coordinator_conversation", { projectId, conversationId });

export const getProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot | null> =>
  invoke("get_project_coordinator", { projectId });

export const COORDINATOR_VIEW_COMMAND = "get_project_coordinator_view";

/**
 * Conditional coordinator read. With `known` (the stamp of the body this
 * client holds) the backend answers `unchanged` without a body while that body
 * is still current. Older backends answer "Unknown backend command".
 */
export const getProjectCoordinatorView = (
  projectId: string,
  known: ViewRevisionStamp | null,
): Promise<unknown> =>
  invoke(COORDINATOR_VIEW_COMMAND, {
    projectId,
    ...(known ? { knownGeneration: known.generation, knownRevision: known.revision } : {}),
  });

/** Every project whose coordinator is working or waiting. Older backends answer "Unknown backend command". */
export const listCoordinatorActivity = (): Promise<CoordinatorActivitySnapshot> =>
  invoke<unknown>(COORDINATOR_ACTIVITY_COMMAND).then(parseCoordinatorActivitySnapshot);

/** Worker tabs whose launch overrode the default. Older backends answer "Unknown backend command". */
export const listCoordinatorLaunchOverrides = (): Promise<CoordinatorLaunchOverridesSnapshot> =>
  invoke<unknown>(COORDINATOR_LAUNCH_OVERRIDES_COMMAND).then(parseCoordinatorLaunchOverrides);

/** The turn holding this project's checkout. Older backends answer "Unknown backend command". */
export const getCoordinatorCheckoutTurn = (
  projectId: string,
): Promise<CoordinatorCheckoutTurn | null> =>
  invoke<unknown>(COORDINATOR_CHECKOUT_TURN_COMMAND, { projectId }).then(
    parseCoordinatorCheckoutTurn,
  );

/**
 * `closeUnused` names unassigned side agents whose composer is empty here; the
 * backend closes those it agrees were never used.
 */
export const createCoordinatorConversation = (
  projectId: string,
  title?: string,
  closeUnused?: readonly string[],
): Promise<CoordinatorSnapshot> =>
  invoke("create_coordinator_conversation", {
    projectId,
    title,
    ...(closeUnused?.length ? { closeUnused } : {}),
  });

export const assignCoordinatorConversationAgent = (
  projectId: string,
  conversationId: string,
  agent: AgentPlatform,
): Promise<CoordinatorSnapshot> =>
  invoke("assign_coordinator_conversation_agent", { projectId, conversationId, agent });

export const selectCoordinatorConversation = (
  projectId: string,
  conversationId: string | null,
): Promise<CoordinatorSnapshot> =>
  invoke("select_coordinator_conversation", { projectId, conversationId });

export const closeCoordinatorConversation = (
  projectId: string,
  conversationId: string,
): Promise<CoordinatorSnapshot> =>
  invoke("close_coordinator_conversation", { projectId, conversationId });

export const pauseProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
  invoke("pause_project_coordinator", { projectId });

export const resumeProjectCoordinator = (projectId: string): Promise<CoordinatorSnapshot> =>
  invoke("resume_project_coordinator", { projectId });

export const getProjectGitStatus = (projectId: string): Promise<ProjectGitStatus> =>
  invoke("get_project_git_status", { projectId });

export const fetchProjectGit = (projectId: string, force = false): Promise<ProjectGitStatus> =>
  invoke("fetch_project_git", { projectId, force });

export const syncProjectGit = (projectId: string): Promise<ProjectGitStatus> =>
  invoke("sync_project_git", { projectId });

export const prepareProjectGitBranchSwitch = (
  projectId: string,
  ref: string,
): Promise<ProjectGitSwitchConfirmation> =>
  invoke("prepare_project_git_branch_switch", { projectId, ref });

export const switchProjectGitBranch = (
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

export const writeCoordinatorAttachment = (
  environmentId: string,
  filename: string,
  base64Data: string,
): Promise<string> =>
  invoke("write_coordinator_attachment", { environmentId, filename, base64Data });

/** Why a pull request link a coordinator showed is, or is not, watched. */
export type CoordinatorPullRequestWatchResult =
  | { watched: true; added: boolean }
  | {
      watched: false;
      reason:
        "other-repository" | "no-repository" | "no-coordinator" | "settled" | "already-followed";
    };

/**
 * A coordinator conversation of `projectId` rendered or opened this pull
 * request: watch it for status changes while it is open. The backend ignores
 * pull requests of other repositories. Older backends answer "Unknown backend
 * command".
 */
export const watchCoordinatorPullRequest = (
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
