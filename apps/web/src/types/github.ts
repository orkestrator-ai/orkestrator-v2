export const GITHUB_STATUS_LABELS = {
  todo: "ork:todo",
  inprogress: "ork:inprogress",
  review: "ork:review",
} as const;

export type GitHubIssueStatus = "backlog" | keyof typeof GITHUB_STATUS_LABELS;

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
