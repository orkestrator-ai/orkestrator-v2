export const GITHUB_STATUS_LABELS = {
  todo: "ork:todo",
  inprogress: "ork:inprogress",
  review: "ork:review",
} as const;

export type GitHubIssueStatus = "backlog" | keyof typeof GITHUB_STATUS_LABELS;

export interface GitHubUser {
  login: string;
  avatarUrl?: string;
  htmlUrl?: string;
}

export interface GitHubLabel {
  name: string;
  color: string;
  description?: string;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  state: "open" | "closed";
  locked: boolean;
  author: GitHubUser | null;
  assignees: GitHubUser[];
  labels: GitHubLabel[];
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  status: GitHubIssueStatus;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  htmlUrl: string;
  author: GitHubUser | null;
  createdAt: string;
  updatedAt: string;
  isEdited: boolean;
  canEdit: boolean;
}

export interface GitHubRepository {
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
}

export type GitHubViewer = GitHubUser;

export interface GitHubIssuesSnapshot {
  repository: GitHubRepository;
  viewer: GitHubViewer;
  issues: GitHubIssue[];
}

export interface GitHubIssueDetail extends GitHubIssue {
  comments: GitHubIssueComment[];
}
