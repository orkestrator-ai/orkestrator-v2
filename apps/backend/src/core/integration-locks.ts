/**
 * The GitHub and Linear write serialisation of one backend: completion
 * comments per pipeline, workflow-label setup per repository and status
 * label changes per issue. Owned by `BackendRuntime` as `integrationLocks`
 * and reached through `context.runtime` at call time; the GitHub client
 * functions that need it take the narrow `GitHubWriteLocks` piece.
 */
export class IntegrationLocks implements GitHubWriteLocks {
  private readonly linearCompletionComments = new Map<string, Promise<unknown>>();
  private readonly githubCompletionComments = new Map<string, Promise<unknown>>();
  private readonly workflowLabelSetups = new Map<string, Promise<void>>();
  private readonly issueStatusUpdates = new Map<string, Promise<unknown>>();

  /** Runs after the pipeline's previous Linear completion comment attempt. */
  withLinearCompletionComment<T>(pipelineId: string, task: () => Promise<T>): Promise<T> {
    return chain(this.linearCompletionComments, pipelineId, task);
  }

  /** Runs after the pipeline's previous GitHub completion comment attempt. */
  withGitHubCompletionComment<T>(pipelineId: string, task: () => Promise<T>): Promise<T> {
    return chain(this.githubCompletionComments, pipelineId, task);
  }

  async joinWorkflowLabelSetup(repositoryKey: string, setup: () => Promise<void>): Promise<void> {
    const existing = this.workflowLabelSetups.get(repositoryKey);
    if (existing) return existing;
    const task = setup();
    this.workflowLabelSetups.set(repositoryKey, task);
    try {
      await task;
    } finally {
      if (this.workflowLabelSetups.get(repositoryKey) === task) {
        this.workflowLabelSetups.delete(repositoryKey);
      }
    }
  }

  async withIssueStatusUpdate<T>(issueKey: string, update: () => Promise<T>): Promise<T> {
    const previous = this.issueStatusUpdates.get(issueKey) ?? Promise.resolve();
    // A failed queued update must not poison the next user attempt.
    const current = previous.then(update, update);
    this.issueStatusUpdates.set(issueKey, current);
    try {
      return await current;
    } finally {
      if (this.issueStatusUpdates.get(issueKey) === current) {
        this.issueStatusUpdates.delete(issueKey);
      }
    }
  }
}

/** What the GitHub client needs: label setup joined per repository, status updates queued per issue. */
export interface GitHubWriteLocks {
  joinWorkflowLabelSetup(repositoryKey: string, setup: () => Promise<void>): Promise<void>;
  withIssueStatusUpdate<T>(issueKey: string, update: () => Promise<T>): Promise<T>;
}

async function chain<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.then(task);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}
