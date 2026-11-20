// The git domain's public surface: the only module other backend code imports.
// Re-export by name (never `export *`) so the surface stays reviewable.
//
// The domain is the Git, GitHub and pull-request code: local Git helpers
// (`blob-read.ts`, `fsmonitor.ts`, `noninteractive-env.ts`, …), the GitHub API
// and CLI clients (`github*.ts`) and the pull-request monitor and auto-merge
// (`pr-*.ts`).
//
// Seven modules are named exceptions in `.oxlintrc.json`, not part of this
// surface, because each reaches back into code that imports this file, so
// re-exporting it here would close a runtime import cycle. Each has one
// importer, which imports it directly:
// - `github-cli-setup.ts` (imports `agent-accounts/index.ts` and
//   `host-tools.ts`), for `commands-registry-tools.ts`;
// - `github-clone-browser.ts` (imports `commands-error-text.ts`), for
//   `commands-registry-projects.ts`;
// - `github-ranges-seed-delivery.ts` (imports `egress-gateway.ts`), for
//   `agent-accounts/containers.ts`;
// - `pr-auto-merge.ts` (imports `project-home-environment.ts` and
//   `action-default-selection.ts`) and `pr-auto-merge-resolve-settled.ts`
//   (imports `native-agent-service-shared.ts` and `public-api/index.ts`), for
//   the composition root `core/index.ts`;
// - `pr-monitor-runtime.ts` (imports `commands-pr-monitor.ts`), for
//   `backend-runtime.ts`;
// - `pr-required-checks.ts` (imports `commands-review.ts`), for
//   `commands-pr-monitor.ts`.
export {
  backgroundBranchFetchRefspec,
  backgroundFetchArgs,
  backgroundFetchRefspec,
  NO_WRITE_FETCH_HEAD,
} from "./background-fetch.js";
export { containerGitBlobReadCommand, decodeGitBatchOutput, readGitBlob } from "./blob-read.js";
export {
  parseGitDiffSummary,
  parseGitFileChanges,
  parseGitNumstat,
  splitNulTerminatedGitFields,
  withoutStatOnlyModifications,
  type GitFileChange,
} from "./diff-summary.js";
export { gitDockerScanPool } from "./docker-scan-pool.js";
export { GitFetchScheduler } from "./fetch-scheduler.js";
export { neutralizeGitFilters } from "./filter-config.js";
export {
  HARDENED_GIT_CONFIG,
  removeLegacyWorktreeFsmonitor,
  retryGitWithoutFsmonitorOnTimeout,
  runGitWithFsmonitorFallback,
  stopGitFsmonitorDaemon,
} from "./fsmonitor.js";
export { gitHubCli, GitHubCliSelection } from "./github-cli-binary.js";
export { GitHubCliLoginSlot } from "./github-cli-login.js";
export {
  containerGitHubCredentialSource,
  getContainerGitHubCredentialStatus,
  getGitHubTokenLogin,
  getHostGitHubToken,
  gitHubCliEnv,
  gitHubCredentialSource,
  resolveContainerGitHubToken,
  resolveGitHubToken,
  type ContainerGitHubCredentialSource,
  type GitHubCliConfigSource,
  type GitHubCredentialSource,
} from "./github-credentials.js";
export { gitHubGitCredentials, gitHubTokenCredentialOptions } from "./github-git-credentials.js";
export {
  addGitHubPullRequestComment,
  addGitHubPullRequestReviewComment,
  changeGitHubPullRequestLabel,
  listGitHubRepositoryAssignableUsers,
  listGitHubRepositoryLabels,
  mergeGitHubPullRequest,
  replyGitHubPullRequestReviewThread,
  setGitHubPullRequestFileViewed,
  setGitHubPullRequestLabels,
  setGitHubPullRequestReviewers,
  setGitHubPullRequestThreadResolved,
  submitGitHubPullRequestReview,
  updateGitHubPullRequestComment,
  updateGitHubPullRequestState,
  type GitHubPullRequestStateAction,
} from "./github-pull-request-actions.js";
export {
  getGitHubPullRequestFilePatch,
  getGitHubPullRequestFiles,
} from "./github-pull-request-files.js";
export { getGitHubPullRequestTimeline } from "./github-pull-request-timeline.js";
export {
  confirmGitHubPullRequestDeleted,
  getGitHubPullRequest,
  getGitHubPullRequestStatus,
  listGitHubPullRequests,
  type GitHubPullRequestStatus,
} from "./github-pull-requests.js";
export {
  githubRangesSeedMountArguments,
  prepareGithubRangesSeedBind,
} from "./github-ranges-cache.js";
export {
  closeGitHubIssue,
  getGitHubIssue,
  GitHubApiError,
  listGitHubIssueComments,
  listGitHubIssues,
  postGitHubIssueComment,
  resolveGitHubRepository,
  sanitizeGitHubError,
  updateGitHubIssue,
  updateGitHubIssueComment,
  updateGitHubIssueStatus,
  type GitHubIssueStatus,
  type GitHubRepositoryRef,
} from "./github.js";
export { isMissingRemoteRefFailure, runRemoteGit } from "./noninteractive-env.js";
export { classifyPrDetectionFailure } from "./pr-monitor-policy.js";
export { type PrDetection, type PrMonitorKanbanTask, type PrMonitorTarget } from "./pr-monitor.js";
export {
  isMergePermissionError,
  parsePrViewerPermission,
  PR_VIEWER_PERMISSION_TIMEOUT_MS,
  prViewerPermissionArgs,
  prViewerPermissionScope,
  prViewerRepository,
  PrViewerPermissionCache,
} from "./pr-viewer-permission.js";
export {
  detectHttpsRemedy,
  sshConnectFailure,
  switchOriginToHttps,
  type SshConnectFailure,
} from "./ssh-transport.js";
