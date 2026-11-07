import type {
  GitHubPullRequestComment,
  GitHubPullRequestDetail,
  GitHubPullRequestFiles,
  GitHubPullRequestInlineCommentInput,
  GitHubPullRequestLabel,
  GitHubPullRequestListFilter,
  GitHubPullRequestListResult,
  GitHubPullRequestMergeMethod,
  GitHubPullRequestMergeResult,
  GitHubPullRequestRef,
  GitHubPullRequestReviewEvent,
  GitHubPullRequestReviewThreadComment,
  GitHubPullRequestTimeline,
  GitHubPullRequestViewedState,
  GitHubRepositoryMemberOption,
} from "@orkestrator/protocol/github-pull-requests";
import { clientInvoke, commandBackendClient, type BackendClient } from "./client";

function refArgs(ref: GitHubPullRequestRef) {
  return { owner: ref.owner, repo: ref.repo, number: ref.number };
}

export type GitHubPullRequestStateAction =
  "close" | "reopen" | "ready-for-review" | "convert-to-draft";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createGithubPullRequestsApi(client: BackendClient) {
  const invoke = clientInvoke(client);

  async function listGitHubPullRequests(
    projectId: string,
    filter: GitHubPullRequestListFilter,
    query?: string,
  ): Promise<GitHubPullRequestListResult> {
    return invoke<GitHubPullRequestListResult>("list_github_pull_requests", {
      projectId,
      filter,
      ...(query?.trim() ? { query: query.trim() } : {}),
    });
  }

  async function getGitHubPullRequest(ref: GitHubPullRequestRef): Promise<GitHubPullRequestDetail> {
    return invoke<GitHubPullRequestDetail>("get_github_pull_request", refArgs(ref));
  }

  async function getGitHubPullRequestTimeline(
    ref: GitHubPullRequestRef,
  ): Promise<GitHubPullRequestTimeline> {
    return invoke<GitHubPullRequestTimeline>("get_github_pull_request_timeline", refArgs(ref));
  }

  async function getGitHubPullRequestFiles(
    ref: GitHubPullRequestRef,
  ): Promise<GitHubPullRequestFiles> {
    return invoke<GitHubPullRequestFiles>("get_github_pull_request_files", refArgs(ref));
  }

  async function mergeGitHubPullRequest(
    ref: GitHubPullRequestRef,
    options: {
      method: GitHubPullRequestMergeMethod;
      deleteBranch: boolean;
      expectedHeadSha?: string;
    },
  ): Promise<GitHubPullRequestMergeResult> {
    return invoke<GitHubPullRequestMergeResult>("merge_github_pull_request", {
      ...refArgs(ref),
      ...options,
    });
  }

  async function updateGitHubPullRequestState(
    ref: GitHubPullRequestRef,
    action: GitHubPullRequestStateAction,
  ): Promise<GitHubPullRequestDetail> {
    return invoke<GitHubPullRequestDetail>("update_github_pull_request_state", {
      ...refArgs(ref),
      action,
    });
  }

  async function addGitHubPullRequestComment(
    ref: GitHubPullRequestRef,
    body: string,
  ): Promise<GitHubPullRequestComment> {
    return invoke<GitHubPullRequestComment>("add_github_pull_request_comment", {
      ...refArgs(ref),
      body,
    });
  }

  async function updateGitHubPullRequestComment(
    ref: GitHubPullRequestRef,
    commentId: number,
    body: string,
  ): Promise<GitHubPullRequestComment> {
    return invoke<GitHubPullRequestComment>("update_github_pull_request_comment", {
      ...refArgs(ref),
      commentId,
      body,
    });
  }

  async function submitGitHubPullRequestReview(
    ref: GitHubPullRequestRef,
    review: {
      event: GitHubPullRequestReviewEvent;
      body: string;
      commitId?: string;
      comments?: GitHubPullRequestInlineCommentInput[];
    },
  ): Promise<{ reviewId: number }> {
    return invoke<{ reviewId: number }>("submit_github_pull_request_review", {
      ...refArgs(ref),
      ...review,
    });
  }

  async function addGitHubPullRequestReviewComment(
    ref: GitHubPullRequestRef,
    commitId: string,
    comment: GitHubPullRequestInlineCommentInput,
  ): Promise<GitHubPullRequestReviewThreadComment> {
    return invoke<GitHubPullRequestReviewThreadComment>("add_github_pull_request_review_comment", {
      ...refArgs(ref),
      commitId,
      comment,
    });
  }

  async function replyGitHubPullRequestReviewThread(
    ref: GitHubPullRequestRef,
    threadId: string,
    body: string,
  ): Promise<GitHubPullRequestReviewThreadComment> {
    return invoke<GitHubPullRequestReviewThreadComment>("reply_github_pull_request_review_thread", {
      ...refArgs(ref),
      threadId,
      body,
    });
  }

  async function setGitHubPullRequestThreadResolved(
    ref: GitHubPullRequestRef,
    threadId: string,
    resolved: boolean,
  ): Promise<{ isResolved: boolean }> {
    return invoke<{ isResolved: boolean }>("set_github_pull_request_thread_resolved", {
      ...refArgs(ref),
      threadId,
      resolved,
    });
  }

  async function setGitHubPullRequestFileViewed(
    ref: GitHubPullRequestRef,
    path: string,
    viewed: boolean,
  ): Promise<{ viewedState: GitHubPullRequestViewedState }> {
    return invoke<{ viewedState: GitHubPullRequestViewedState }>(
      "set_github_pull_request_file_viewed",
      { ...refArgs(ref), path, viewed },
    );
  }

  async function setGitHubPullRequestReviewers(
    ref: GitHubPullRequestRef,
    changes: { add: string[]; remove: string[] },
  ): Promise<GitHubPullRequestDetail> {
    return invoke<GitHubPullRequestDetail>("set_github_pull_request_reviewers", {
      ...refArgs(ref),
      ...changes,
    });
  }

  async function setGitHubPullRequestLabels(
    ref: GitHubPullRequestRef,
    labels: string[],
  ): Promise<GitHubPullRequestLabel[]> {
    return invoke<GitHubPullRequestLabel[]>("set_github_pull_request_labels", {
      ...refArgs(ref),
      labels,
    });
  }

  async function listGitHubRepositoryAssignableUsers(repository: {
    owner: string;
    repo: string;
  }): Promise<GitHubRepositoryMemberOption[]> {
    return invoke<GitHubRepositoryMemberOption[]>("list_github_repository_assignable_users", {
      owner: repository.owner,
      repo: repository.repo,
    });
  }

  async function listGitHubRepositoryLabels(repository: {
    owner: string;
    repo: string;
  }): Promise<GitHubPullRequestLabel[]> {
    return invoke<GitHubPullRequestLabel[]>("list_github_repository_labels", {
      owner: repository.owner,
      repo: repository.repo,
    });
  }

  async function changeGitHubPullRequestLabel(
    ref: GitHubPullRequestRef,
    name: string,
    present: boolean,
  ): Promise<GitHubPullRequestLabel[]> {
    return invoke<GitHubPullRequestLabel[]>("change_github_pull_request_label", {
      ...refArgs(ref),
      name,
      present,
    });
  }

  return {
    listGitHubPullRequests,
    getGitHubPullRequest,
    getGitHubPullRequestTimeline,
    getGitHubPullRequestFiles,
    mergeGitHubPullRequest,
    updateGitHubPullRequestState,
    addGitHubPullRequestComment,
    updateGitHubPullRequestComment,
    submitGitHubPullRequestReview,
    addGitHubPullRequestReviewComment,
    replyGitHubPullRequestReviewThread,
    setGitHubPullRequestThreadResolved,
    setGitHubPullRequestFileViewed,
    setGitHubPullRequestReviewers,
    setGitHubPullRequestLabels,
    listGitHubRepositoryAssignableUsers,
    listGitHubRepositoryLabels,
    changeGitHubPullRequestLabel,
  };
}

export type GithubPullRequestsApi = ReturnType<typeof createGithubPullRequestsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  listGitHubPullRequests,
  getGitHubPullRequest,
  getGitHubPullRequestTimeline,
  getGitHubPullRequestFiles,
  mergeGitHubPullRequest,
  updateGitHubPullRequestState,
  addGitHubPullRequestComment,
  updateGitHubPullRequestComment,
  submitGitHubPullRequestReview,
  addGitHubPullRequestReviewComment,
  replyGitHubPullRequestReviewThread,
  setGitHubPullRequestThreadResolved,
  setGitHubPullRequestFileViewed,
  setGitHubPullRequestReviewers,
  setGitHubPullRequestLabels,
  listGitHubRepositoryAssignableUsers,
  listGitHubRepositoryLabels,
  changeGitHubPullRequestLabel,
} = createGithubPullRequestsApi(commandBackendClient);
