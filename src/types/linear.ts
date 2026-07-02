export interface LinearViewer {
  id: string;
  name: string;
  email?: string;
}

export interface LinearConnectionStatus {
  connected: boolean;
  hasToken: boolean;
  viewer?: LinearViewer;
  error?: string;
}

export interface LinearIssueListItem {
  id: string;
  identifier: string;
  title: string;
  status: string;
  statusType?: string;
  sortOrder?: number;
  updatedAt: string;
  createdAt?: string;
  url?: string;
  teamKey?: string;
  teamName?: string;
  assigneeName?: string;
  priorityLabel?: string;
}

export interface LinearIssueDetail extends LinearIssueListItem {
  description: string;
  creatorName?: string;
  projectName?: string;
  cycleName?: string;
  labels: string[];
}

export interface LinearCompletionCommentResult {
  status: "posted" | "already-posted";
  commentId: string;
  postedAt?: string;
}
