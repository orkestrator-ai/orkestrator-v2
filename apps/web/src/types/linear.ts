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
  /**
   * A short SHA-256 fingerprint of the stored key (16 hex characters), so
   * machines can tell whether they hold the same key. Never the key.
   */
  keyFingerprint?: string;
  connectedAt?: string;
}

/**
 * The Linear board one Orkestrator project uses: a team, optionally narrowed
 * to one Linear project in it. Keyed by the project's repository, so it is the
 * same on every machine with that repository.
 */
export interface LinearBoardLink {
  key: string;
  repositoryHint?: string;
  projectId?: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  linearProjectId?: string;
  linearProjectName?: string;
  updatedAt: string;
  cleared?: boolean;
}

export interface LinearTeamProject {
  id: string;
  name?: string;
  state?: string;
}

/** A Linear team (one board) and its projects, for the board picker. */
export interface LinearTeam {
  id: string;
  key?: string;
  name?: string;
  projects?: LinearTeamProject[];
}

/** Another machine's Linear connection, as the command node last read it. Never a key. */
export interface LinearNodeConnection {
  nodeId: string;
  nodeName?: string;
  connected: boolean;
  viewerName?: string;
  keyFingerprint?: string;
  readAt?: string;
}

export interface LinearIssueListItem {
  id: string;
  identifier: string;
  title: string;
  status: string;
  statusType?: string;
  statusPosition?: number;
  sortOrder?: number;
  priority?: number;
  prioritySortOrder?: number;
  updatedAt: string;
  createdAt?: string;
  url?: string;
  teamKey?: string;
  teamName?: string;
  assigneeName?: string;
  priorityLabel?: string;
}

export interface LinearIssueComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
  authorName?: string;
}

export interface LinearIssueDetail extends LinearIssueListItem {
  description: string;
  creatorName?: string;
  projectName?: string;
  cycleName?: string;
  labels: string[];
  comments: LinearIssueComment[];
}

export interface LinearCompletionCommentResult {
  status: "posted" | "already-posted";
  commentId: string;
  postedAt?: string;
}

/** A workflow state of a board: one lane of the Linear board view. */
export interface LinearWorkflowState {
  id: string;
  name?: string;
  type?: string;
  position?: number;
}

/** A linked board's workflow states, labels and members. */
export interface LinearBoardOptions {
  teamId: string;
  states?: LinearWorkflowState[];
  labels?: Array<{ id: string; name?: string; color?: string }>;
  members?: Array<{ id: string; name?: string; displayName?: string; email?: string }>;
}
