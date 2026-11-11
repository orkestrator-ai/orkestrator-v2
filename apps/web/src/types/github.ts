/** A ticket's GitHub workflow label (`ork:<status>`, see the backend's `GITHUB_STATUS_LABELS`), or none. */
export type GitHubIssueStatus = "backlog" | "todo" | "inprogress" | "review";

/**
 * The GitHub issue model is the `pull-requests` domain's (plan item 7006):
 * the types are inferred from its schemas, which the backend's `github.ts`
 * uses too, so the two cannot drift.
 */
export type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueDetail,
  GitHubIssuesSnapshot,
  GitHubLabel,
  GitHubRepository,
  GitHubUser,
  GitHubUser as GitHubViewer,
} from "@orkestrator/protocol/contract/domains/pull-requests";
