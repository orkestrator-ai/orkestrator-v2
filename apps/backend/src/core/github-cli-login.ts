import { randomUUID } from "node:crypto";

import type { AgentAccountLoginHandle } from "./agent-accounts-login.js";

export type GitHubCliOperationState = "idle" | "pending" | "succeeded" | "failed";

export interface GitHubCliLoginProgress {
  state: GitHubCliOperationState;
  operationId?: string;
  url?: string;
  userCode?: string;
  error?: string;
}

interface ActiveLogin {
  operationId: string;
  state: Exclude<GitHubCliOperationState, "idle">;
  handle?: AgentAccountLoginHandle;
  cancelled?: boolean;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The single in-flight GitHub CLI sign-in of one backend. Owned by
 * `LocalServerRuntime` as `gitHubCliLogin` and driven by `startGitHubCliLogin`,
 * `gitHubCliLoginProgress` and `cancelGitHubCliLogin` in `github-cli-setup.ts`.
 *
 * This isolates progress and cancellation only: `gh auth login` writes the host
 * user's `gh` configuration, so two backends signing in at once still race on it.
 */
export class GitHubCliLoginSlot {
  private active: ActiveLogin | undefined;

  /** Joins the pending sign-in, or begins one with `begin`. */
  async start(begin: () => Promise<AgentAccountLoginHandle>): Promise<GitHubCliLoginProgress> {
    if (this.active?.state === "pending") return this.progress();
    const entry: ActiveLogin = { operationId: randomUUID(), state: "pending" };
    this.active = entry;
    let handle: AgentAccountLoginHandle;
    try {
      handle = await begin();
    } catch (error) {
      entry.state = "failed";
      entry.error = entry.cancelled ? "The sign-in was cancelled" : errorMessage(error);
      throw new Error(entry.error);
    }
    if (entry.cancelled) {
      handle.cancel();
      throw new Error("The sign-in was cancelled");
    }
    entry.handle = handle;
    void handle.completion.then(
      () => {
        entry.state = "succeeded";
      },
      (error: unknown) => {
        entry.state = "failed";
        entry.error = entry.cancelled ? "The sign-in was cancelled" : errorMessage(error);
      },
    );
    return this.progress();
  }

  progress(): GitHubCliLoginProgress {
    const entry = this.active;
    if (!entry) return { state: "idle" };
    return {
      state: entry.state,
      operationId: entry.operationId,
      ...(entry.state === "pending" && entry.handle
        ? {
            url: entry.handle.url,
            ...(entry.handle.userCode ? { userCode: entry.handle.userCode } : {}),
          }
        : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  /** Cancel a pending sign-in, or dismiss a finished one. */
  cancel(operationId?: string): GitHubCliLoginProgress {
    const entry = this.active;
    if (operationId && entry?.operationId !== operationId) return this.progress();
    this.active = undefined;
    if (entry?.state === "pending") {
      entry.cancelled = true;
      entry.handle?.cancel();
    }
    return this.progress();
  }
}
